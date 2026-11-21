import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../db/migrate';
import { DEMO_PASSWORD, seed } from '../db/seed';
import { checkInvariants, printResults } from './invariants';

/**
 * The failure demo (SPEC §8). Runs the backend in containers, breaks it on purpose while orders are in
 * flight, then checks the invariants. Usage (from the repo root): pnpm demo:failures
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const COMPOSE = `docker compose -f ${join(ROOT, 'docker-compose.yml')} -f ${join(ROOT, 'docker-compose.demo.yml')}`;
const API = 'http://127.0.0.1:4000';
const SIM = 'http://127.0.0.1:4100';
const DB_URL = 'postgres://waybill:waybill@127.0.0.1:55432/waybill';
const SLA_SECONDS = 40;

const db = new Pool({ connectionString: DB_URL, max: 4 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT }).toString();
const compose = (args: string) => sh(`${COMPOSE} ${args}`);
const t0 = Date.now();
const log = (msg: string) => console.log(`${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s  ${msg}`);

const AREAS = {
  garki: { lat: 9.0333, lng: 7.4833 },
  wuse2: { lat: 9.0765, lng: 7.4693 },
  maitama: { lat: 9.0882, lng: 7.4932 },
  utako: { lat: 9.0663, lng: 7.4429 },
  kubwa: { lat: 9.1559, lng: 7.3227 },
  kubwaNorth: { lat: 9.17, lng: 7.33 },
};

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, base = API): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`), { status: res.status, body: json });
      return json;
    } catch (err: any) {
      if (err.status || i >= 20) throw err;
      await sleep(500); // the api may be restarting
    }
  }
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(500);
  }
}

async function createOrder(from: keyof typeof AREAS, to: keyof typeof AREAS, label: string) {
  const r = await http('POST', '/orders', {
    customer: { name: `Demo ${label}`, phone: '08000000000', email: `${label.toLowerCase()}@example.com` },
    receiverName: 'Demo Receiver',
    pickup: { address: `1 Demo Street, ${from}`, location: AREAS[from] },
    dropoff: { address: `2 Demo Close, ${to}`, location: AREAS[to] },
    item: `Parcel ${label}`,
    packageSize: 'small',
  });
  return { id: r.order.id as string, token: r.trackingToken as string };
}

async function startCheckout(token: string, key: string): Promise<string> {
  return (await http('POST', `/track/${token}/pay`, undefined, { 'idempotency-key': key })).reference;
}

const simPay = (ref: string, webhook: 'normal' | 'none' | 'duplicate' = 'normal') => http('POST', `/_sim/pay/${ref}?webhook=${webhook}`, undefined, {}, SIM);
const statusOf = async (id: string) => (await db.query(`SELECT status FROM orders WHERE id = $1`, [id])).rows[0]?.status as string;
const waitStatus = (id: string, want: string[], ms = 90_000) => until(`order ${id.slice(-6)} → ${want.join('/')}`, async () => want.includes(await statusOf(id)) && (await statusOf(id)), ms);

async function login(email: string) {
  return (await http('POST', '/auth/login', { email, password: DEMO_PASSWORD })).token as string;
}

interface Scenario {
  id: string;
  title: string;
  run: () => Promise<string>;
}

let simDrivers: ChildProcess | null = null;

const scenarios: Scenario[] = [
  {
    id: 'F5',
    title: 'Paid, but no driver takes it within the SLA → cancel + refund, once',
    async run() {
      const o = await createOrder('garki', 'wuse2', 'F5');
      const ref = await startCheckout(o.token, 'f5');
      await simPay(ref);
      await waitStatus(o.id, ['PAID', 'OFFERED']);
      log(`F5: paid; no drivers online; waiting for the ${SLA_SECONDS}s SLA`);
      await waitStatus(o.id, ['CANCELLED'], (SLA_SECONDS + 30) * 1000);
      await until('refund processed', async () => (await db.query(`SELECT status FROM payments WHERE provider_reference = $1`, [ref])).rows[0].status === 'refunded', 30_000);
      return 'cancelled "no driver available"; payment refunded';
    },
  },
  {
    id: 'F6',
    title: 'Customer pays twice (two checkouts) → the second is refunded automatically',
    async run() {
      const o = await createOrder('garki', 'maitama', 'F6');
      const a = await startCheckout(o.token, 'f6-tab-1');
      const b = await startCheckout(o.token, 'f6-tab-2');
      await simPay(a);
      await simPay(b);
      await until('one primary, one refunded', async () => {
        const rows = (await db.query(`SELECT role, status FROM payments WHERE order_id = $1`, [o.id])).rows;
        return rows.some((r) => r.role === 'primary' && r.status === 'succeeded') && rows.some((r) => r.role === 'extra' && r.status === 'refunded');
      });
      return 'one payment kept, the duplicate refunded';
    },
  },
  {
    id: 'F7',
    title: 'The charge.success webhook never arrives → the reconciler completes the payment',
    async run() {
      const o = await createOrder('utako', 'wuse2', 'F7');
      const ref = await startCheckout(o.token, 'f7');
      await simPay(ref, 'none');
      await waitStatus(o.id, ['PAID', 'OFFERED', 'ASSIGNED'], 30_000);
      const inbox = (await db.query(`SELECT count(*)::int AS n FROM inbox WHERE event_id LIKE $1`, [`%${ref}%`])).rows[0].n;
      return `paid via verify (webhooks received for it: ${inbox})`;
    },
  },
  {
    id: 'START',
    title: 'Start 3 simulated drivers (they go offline for 10 s after every pickup: F8)',
    async run() {
      simDrivers = spawn('npx', ['tsx', join(__dirname, '..', 'sim', 'drivers.ts'), '--count', '3', '--speed', '4', '--offline-after-pickup', '10'], {
        env: { ...process.env, API_URL: API },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      simDrivers.stdout!.on('data', (d) => process.env.DEMO_VERBOSE && process.stdout.write(`        sim: ${d}`));
      await until('drivers online', async () => (await db.query(`SELECT count(*)::int AS n FROM drivers WHERE status = 'available' AND last_seen_at > now() - interval '30 seconds'`)).rows[0].n >= 3, 30_000);
      return 'Musa, Ifeoma and Ade online';
    },
  },
  {
    id: 'F1',
    title: 'kill -9 the worker; a payment commits while it is down → nothing lost after restart',
    async run() {
      compose('kill -s SIGKILL worker');
      log('F1: worker killed');
      const o = await createOrder('garki', 'wuse2', 'F1');
      const ref = await startCheckout(o.token, 'f1');
      await simPay(ref);
      await waitStatus(o.id, ['PAID']);
      const waiting = (await db.query(`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`)).rows[0].n;
      log(`F1: order PAID with the worker down; ${waiting} events waiting in the outbox`);
      await sleep(3_000);
      compose('start worker');
      log('F1: worker restarted');
      await waitStatus(o.id, ['DELIVERED'], 120_000);
      return `outbox held ${waiting} events while the worker was dead; order delivered`;
    },
  },
  {
    id: 'F1b',
    title: 'kill -9 the api mid-delivery → the driver app keeps retrying; delivery completes once',
    async run() {
      const o = await createOrder('maitama', 'utako', 'F1b');
      const ref = await startCheckout(o.token, 'f1b');
      await simPay(ref);
      await waitStatus(o.id, ['EN_ROUTE_TO_PICKUP', 'PICKED_UP', 'EN_ROUTE_TO_DROPOFF'], 60_000);
      compose('kill -s SIGKILL api');
      log('F1b: api killed mid-delivery');
      await sleep(8_000);
      compose('start api');
      log('F1b: api restarted');
      await waitStatus(o.id, ['DELIVERED'], 120_000);
      return 'delivered after an 8 s api outage';
    },
  },
  {
    id: 'F2',
    title: 'The api is down when Paystack sends the webhook → Paystack retries; processed exactly once',
    async run() {
      const o = await createOrder('wuse2', 'garki', 'F2');
      const ref = await startCheckout(o.token, 'f2');
      compose('kill -s SIGKILL api');
      log('F2: api killed; customer pays now');
      await simPay(ref, 'duplicate');
      await sleep(5_000);
      compose('start api');
      log('F2: api restarted');
      await waitStatus(o.id, ['DELIVERED'], 120_000);
      const groups = (await db.query(`SELECT count(DISTINCT entry_group)::int AS n FROM ledger_entries l JOIN payments p ON p.id = l.payment_id WHERE p.provider_reference = $1`, [ref])).rows[0].n;
      return `3 copies of the webhook, retried through the outage; ${groups} ledger entry for the payment`;
    },
  },
  {
    id: 'F3',
    title: 'RabbitMQ is down for 30 s while orders are paid → the outbox backs up and drains',
    async run() {
      compose('stop rabbitmq');
      log('F3: RabbitMQ stopped');
      const orders = [];
      for (const [i, pair] of ([['garki', 'maitama'], ['utako', 'wuse2'], ['wuse2', 'utako']] as const).entries()) {
        const o = await createOrder(pair[0], pair[1], `F3-${i}`);
        await simPay(await startCheckout(o.token, `f3-${i}`));
        orders.push(o);
      }
      for (const o of orders) await waitStatus(o.id, ['PAID']);
      const health = await http('GET', '/dispatch/health', undefined, { authorization: `Bearer ${await login('dispatch@waybill.test')}` });
      log(`F3: 3 orders paid; dashboard shows outbox ${health.outbox.waiting} waiting (oldest ${health.outbox.oldest_seconds}s)`);
      await sleep(30_000);
      compose('start rabbitmq');
      log('F3: RabbitMQ started; the worker reconnects');
      for (const o of orders) await waitStatus(o.id, ['DELIVERED'], 180_000);
      return `outbox peaked at ${health.outbox.waiting}; all 3 delivered`;
    },
  },
  {
    id: 'F9',
    title: 'Dispatch cancels while the driver is offline; the driver then marks pickup → rejected, refunded',
    async run() {
      // Tunde is not simulated; he is the only driver near Kubwa, so the order is offered to him.
      const tunde = await login('tunde@drivers.waybill.test');
      const auth = { authorization: `Bearer ${tunde}` };
      await http('POST', '/driver/locations', { points: [{ seq: Date.now(), recordedAt: new Date().toISOString(), ...AREAS.kubwaNorth }] }, auth);
      await http('POST', '/driver/availability', { status: 'available' }, auth);
      const o = await createOrder('kubwa', 'kubwaNorth', 'F9');
      await simPay(await startCheckout(o.token, 'f9'));
      await waitStatus(o.id, ['OFFERED']);
      const cmd = (type: string, payload = {}) => ({ commandId: crypto.randomUUID(), orderId: o.id, type, occurredAt: new Date().toISOString(), payload });
      await http('POST', '/driver/commands', cmd('accept_offer'), auth);
      await http('POST', '/driver/commands', cmd('start_trip'), auth);
      log('F9: Tunde is on the way to pickup and goes offline; dispatch cancels');
      const dispatcher = await login('dispatch@waybill.test');
      await http('POST', `/dispatch/orders/${o.id}/cancel`, { reason: 'customer called to cancel', commandId: crypto.randomUUID() }, { authorization: `Bearer ${dispatcher}` });
      const queuedPickup = cmd('confirm_pickup', { photoId: 'offline-photo-1' });
      const err = await http('POST', '/driver/commands', queuedPickup, auth).catch((e) => e);
      if (err?.status !== 409) throw new Error(`expected 409, got ${err?.status ?? 'success'}`);
      await until('refund processed', async () => (await db.query(`SELECT status FROM payments WHERE order_id = $1 AND role = 'primary'`, [o.id])).rows[0]?.status === 'refunded', 30_000);
      await http('POST', '/driver/availability', { status: 'offline' }, auth).catch(() => undefined);
      return `pickup rejected with 409 (order is ${err.body.status}); payment refunded`;
    },
  },
];

async function quiesce() {
  await until(
    'everything settled',
    async () => {
      const r = (
        await db.query(`SELECT
            (SELECT count(*) FROM outbox WHERE published_at IS NULL)::int AS outbox,
            (SELECT count(*) FROM orders WHERE status NOT IN ('DELIVERED','CANCELLED','EXPIRED','RETURNED','AWAITING_PAYMENT'))::int AS active,
            (SELECT count(*) FROM payments WHERE status = 'refund_pending')::int AS refunds`)
      ).rows[0];
      return r.outbox === 0 && r.active === 0 && r.refunds === 0;
    },
    120_000,
  );
  await sleep(3_000); // let the last consumers record their messages
}

async function main() {
  console.log('Waybill failure demo\n');
  log('starting Postgres, RabbitMQ and Redis');
  compose('up -d --wait postgres rabbitmq redis');
  compose('rm -sf api worker realtime paystack-sim');
  log('resetting the database');
  await migrate(DB_URL, { reset: true, quiet: true });
  await seed(DB_URL);
  sh(`docker compose -f ${join(ROOT, 'docker-compose.yml')} exec -T rabbitmq sh -c "rabbitmqctl list_queues -q name | xargs -r -n1 rabbitmqctl delete_queue >/dev/null 2>&1 || true"`);
  log('building and starting api, worker, realtime and the Paystack simulator');
  compose('up -d --build api worker realtime paystack-sim');
  await until('api healthy', async () => (await fetch(`${API}/health`)).ok, 120_000);
  await until('simulator healthy', async () => (await fetch(`${SIM}/health`)).ok, 60_000);

  const results: Array<{ id: string; title: string; ok: boolean; note: string }> = [];
  for (const s of scenarios) {
    log(`${s.id}: ${s.title}`);
    try {
      const note = await s.run();
      results.push({ id: s.id, title: s.title, ok: true, note });
      log(`${s.id}: ✓ ${note}`);
    } catch (err: any) {
      results.push({ id: s.id, title: s.title, ok: false, note: err.message });
      log(`${s.id}: ✗ ${err.message}`);
    }
  }

  log('waiting for every order, event and refund to settle');
  await quiesce().catch((e) => log(`warning: ${e.message}`));
  simDrivers?.kill();

  // F8 ran on every simulated delivery: drivers went offline for 10 s after pickup.
  const late = (await db.query(`SELECT count(*)::int AS n FROM order_events WHERE actor = 'driver' AND recorded_at - occurred_at > interval '5 seconds'`)).rows[0].n;
  const latePts = (await db.query(`SELECT count(*)::int AS n FROM location_points WHERE received_at - recorded_at > interval '5 seconds'`)).rows[0].n;
  const dupes = (await db.query(`SELECT count(*)::int AS n FROM (SELECT order_id, type FROM order_events WHERE actor = 'driver' GROUP BY 1, 2 HAVING count(*) > 1) x`)).rows[0].n;
  results.push({
    id: 'F8',
    title: 'Drivers go offline after pickup, keep working, then sync',
    ok: late > 0 && dupes === 0,
    note: `${late} driver steps and ${latePts} location points recorded after the fact; ${dupes} duplicated steps`,
  });

  console.log('\nScenarios:');
  for (const r of results.filter((x) => x.id !== 'START')) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}  ${r.title}\n        ${r.note}`);
  console.log('\nInvariants:');
  const inv = await checkInvariants(db, { slaSeconds: SLA_SECONDS });
  const invOk = printResults(inv);
  const counts = (await db.query(`SELECT status, count(*)::int AS n FROM orders GROUP BY status ORDER BY status`)).rows;
  console.log(`\nOrders: ${counts.map((c) => `${c.n} ${c.status.toLowerCase()}`).join(', ')}`);
  const allOk = invOk && results.every((r) => r.ok);
  console.log(allOk ? '\nAll scenarios passed and all invariants hold.' : '\nSomething failed; see above.');
  await db.end();
  process.exit(allOk ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  simDrivers?.kill();
  process.exit(2);
});
