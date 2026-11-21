import { createHmac, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A local stand-in for Paystack's test mode, for offline and repeatable demos (SPEC §8). It speaks the parts
 * of the API Waybill uses (initialize, verify, refund), shows a fake checkout page, and sends signed webhooks
 * with Paystack's HMAC-SHA512 scheme, retrying like Paystack when the receiver doesn't answer 200.
 *
 * Control routes for the failure demo:
 *   POST /_sim/pay/:reference?webhook=normal|none|duplicate   mark paid without the browser
 *   GET  /_sim/state
 */

const PORT = Number(process.env.SIM_PORT ?? 4100);
const PUBLIC_URL = process.env.SIM_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;
const SECRET = process.env.PAYSTACK_SECRET_KEY ?? 'sk_test_waybill_local';
const WEBHOOK_URL = process.env.SIM_WEBHOOK_URL ?? 'http://127.0.0.1:4000/webhooks/paystack';
const STATE_FILE = process.env.SIM_STATE_FILE ?? '';

interface Txn {
  id: number;
  reference: string;
  amount: number;
  email: string;
  callbackUrl: string;
  status: 'pending' | 'success' | 'reversed';
  refundId?: number;
}

let txns: Record<string, Txn> = {};
if (STATE_FILE && existsSync(STATE_FILE)) txns = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const save = () => STATE_FILE && writeFileSync(STATE_FILE, JSON.stringify(txns));

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

/** Delivers a webhook, retrying on failure (Paystack retries for up to 72h; we use a short schedule). */
async function deliver(event: string, data: Record<string, unknown>, copies = 1) {
  const body = JSON.stringify({ event, data });
  const signature = createHmac('sha512', SECRET).update(body).digest('hex');
  const once = async () => {
    for (const delay of [0, 1_000, 3_000, 10_000, 30_000, 60_000]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return;
        console.log(`[sim] webhook ${event} → ${res.status}; will retry`);
      } catch (err: any) {
        console.log(`[sim] webhook ${event} failed (${err.message}); will retry`);
      }
    }
    console.log(`[sim] webhook ${event} gave up`);
  };
  await Promise.all(Array.from({ length: copies }, once));
}

function markPaid(t: Txn, webhook: string) {
  if (t.status !== 'pending') return;
  t.status = 'success';
  save();
  const data = { id: t.id, reference: t.reference, amount: t.amount, currency: 'NGN', status: 'success', customer: { email: t.email } };
  if (webhook === 'none') return; // F7: the webhook is lost; only verify will tell
  void deliver('charge.success', data, webhook === 'duplicate' ? 3 : 1);
}

const authed = (req: IncomingMessage) => req.headers.authorization === `Bearer ${SECRET}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', PUBLIC_URL);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'POST' && url.pathname === '/transaction/initialize') {
      if (!authed(req)) return send(res, 401, { status: false, message: 'Invalid key' });
      const b = await readBody(req);
      if (txns[b.reference]) return send(res, 400, { status: false, message: 'Duplicate Transaction Reference' });
      const t: Txn = { id: randomInt(1e6, 1e9), reference: b.reference, amount: Number(b.amount), email: b.email, callbackUrl: b.callback_url, status: 'pending' };
      txns[t.reference] = t;
      save();
      return send(res, 200, { status: true, message: 'Authorization URL created', data: { authorization_url: `${PUBLIC_URL}/checkout/${t.reference}`, access_code: 'sim', reference: t.reference } });
    }
    if (req.method === 'GET' && parts[0] === 'transaction' && parts[1] === 'verify') {
      if (!authed(req)) return send(res, 401, { status: false, message: 'Invalid key' });
      const t = txns[decodeURIComponent(parts[2] ?? '')];
      if (!t) return send(res, 400, { status: false, message: 'Transaction reference not found' });
      const status = t.status === 'pending' ? 'abandoned' : t.status;
      return send(res, 200, { status: true, data: { id: t.id, reference: t.reference, amount: t.amount, currency: 'NGN', status } });
    }
    if (req.method === 'POST' && url.pathname === '/refund') {
      if (!authed(req)) return send(res, 401, { status: false, message: 'Invalid key' });
      const b = await readBody(req);
      const t = txns[b.transaction];
      if (!t) return send(res, 400, { status: false, message: 'Transaction not found' });
      if (t.status === 'reversed') return send(res, 400, { status: false, message: 'Transaction has been fully reversed' });
      if (t.status !== 'success') return send(res, 400, { status: false, message: 'Cannot refund an unsuccessful transaction' });
      t.status = 'reversed';
      t.refundId = randomInt(1e6, 1e9);
      save();
      setTimeout(() => void deliver('refund.processed', { id: t.refundId, transaction_reference: t.reference, amount: t.amount, currency: 'NGN', status: 'processed' }), 1_000);
      return send(res, 200, { status: true, message: 'Refund has been queued for processing', data: { id: t.refundId, status: 'pending', amount: t.amount } });
    }
    if (req.method === 'GET' && parts[0] === 'checkout' && parts[1]) {
      const t = txns[decodeURIComponent(parts[1])];
      if (!t) return void res.writeHead(404).end('unknown checkout');
      const naira = `₦${(t.amount / 100).toLocaleString('en-NG')}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test checkout</title>
<style>body{font-family:system-ui,sans-serif;background:#F7F8FA;color:#0E1116;margin:0;display:grid;place-items:center;min-height:100vh}main{background:#fff;border:1px solid #D9DDE3;border-radius:12px;padding:28px;max-width:360px;width:calc(100% - 32px);box-sizing:border-box}h1{font-size:20px;margin:0 0 4px}p{color:#3A414C}button{width:100%;height:52px;border:0;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;margin-top:8px}.pay{background:#1D4ED8;color:#fff}.cancel{background:#fff;border:2px solid #0E1116}</style></head>
<body><main><h1>Paystack test checkout</h1><p>Local simulator · no real money. ${t.email}</p><p style="font-size:28px;font-weight:700;margin:16px 0">${naira}</p>
${t.status === 'pending' ? `<form method="post" action="/checkout/${t.reference}/pay"><button class="pay">Pay ${naira}</button></form><form method="get" action="${t.callbackUrl}"><button class="cancel">Cancel</button></form>` : `<p>This transaction is ${t.status}.</p><a href="${t.callbackUrl}">Back to Waybill</a>`}
</main></body></html>`);
      return;
    }
    if (req.method === 'POST' && parts[0] === 'checkout' && parts[2] === 'pay') {
      const t = txns[decodeURIComponent(parts[1] ?? '')];
      if (!t) return void res.writeHead(404).end('unknown checkout');
      markPaid(t, 'normal');
      const back = new URL(t.callbackUrl);
      back.searchParams.set('reference', t.reference);
      return void res.writeHead(303, { location: back.toString() }).end();
    }
    if (req.method === 'POST' && parts[0] === '_sim' && parts[1] === 'pay') {
      const t = txns[decodeURIComponent(parts[2] ?? '')];
      if (!t) return send(res, 404, { error: 'unknown reference' });
      markPaid(t, url.searchParams.get('webhook') ?? 'normal');
      return send(res, 200, { ok: true, status: t.status });
    }
    if (req.method === 'GET' && url.pathname === '/_sim/state') return send(res, 200, txns);
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    send(res, 404, { status: false, message: 'not found' });
  } catch (err: any) {
    console.error('[sim]', err);
    send(res, 500, { status: false, message: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[sim] Paystack simulator on :${PORT}, webhooks → ${WEBHOOK_URL}`));
