import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig, type Config } from '../src/config';
import { createCore, type Core } from '../src/core';
import { point } from '../src/db/db';
import { migrate } from '../src/db/migrate';
import { seed } from '../src/db/seed';
import { PaystackProvider, ProviderError, type ChargeStatus } from '../src/payments/provider';
import { NullPublisher } from '../src/realtime/publisher';

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://waybill:waybill@127.0.0.1:55432/waybill';
export const TEST_DB_URL = BASE_URL.replace(/\/[^/]+$/, '/waybill_test');
export const SECRET = 'sk_test_unit';

/** In-memory Paystack with the real signature scheme. */
export class FakeProvider extends PaystackProvider {
  charges = new Map<string, { status: ChargeStatus; amount: number; refunded?: boolean }>();
  refundCalls: string[] = [];
  constructor() {
    super('http://fake.invalid', SECRET);
  }
  override async initialize(input: { reference: string; amountKobo: number }) {
    this.charges.set(input.reference, { status: 'abandoned', amount: input.amountKobo });
    return { checkoutUrl: `https://checkout.fake/${input.reference}` };
  }
  override async verify(reference: string): Promise<{ status: ChargeStatus; amountKobo?: number; currency?: string; refunded?: boolean }> {
    const c = this.charges.get(reference);
    if (!c) return { status: 'not_found' };
    return { status: c.status, amountKobo: c.amount, currency: 'NGN', refunded: c.refunded };
  }
  override async refund(reference: string, _amount: number) {
    this.refundCalls.push(reference);
    const c = this.charges.get(reference);
    if (c?.refunded) throw new ProviderError('Transaction has been fully reversed', 'already_refunded');
    if (c) c.refunded = true;
    return { refundId: `rf_${reference}`, status: 'pending' as const };
  }
}

export function signed(body: unknown): { raw: Buffer; sig: string } {
  const raw = Buffer.from(JSON.stringify(body));
  return { raw, sig: createHmac('sha512', SECRET).update(raw).digest('hex') };
}

export const chargeSuccess = (reference: string, amount: number, id = 1) => signed({ event: 'charge.success', data: { id, reference, amount, currency: 'NGN', status: 'success' } });
export const refundProcessed = (reference: string, amount: number, id = 9) =>
  signed({ event: 'refund.processed', data: { id, transaction_reference: reference, amount, currency: 'NGN', status: 'processed' } });

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig(), databaseUrl: TEST_DB_URL, paystackSecretKey: SECRET, reconcileAfterSeconds: 0, ...overrides };
}

export async function resetDb(): Promise<void> {
  const admin = new Pool({ connectionString: BASE_URL, max: 1 });
  const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'waybill_test'`);
  if (!exists.rowCount) await admin.query('CREATE DATABASE waybill_test');
  await admin.end();
  await migrate(TEST_DB_URL, { reset: true, quiet: true });
  await seed(TEST_DB_URL);
}

export interface TestCore extends Core {
  fake: FakeProvider;
  published: NullPublisher;
}

export function makeCore(overrides: Partial<Config> = {}): TestCore {
  const fake = new FakeProvider();
  const published = new NullPublisher();
  const core = createCore(testConfig(overrides), { provider: fake, realtime: published });
  return Object.assign(core, { fake, published });
}

export const GARKI = { lat: 9.0333, lng: 7.4833 };
export const WUSE2 = { lat: 9.0765, lng: 7.4693 };

export function orderInput(size: 'small' | 'medium' | 'large' = 'small') {
  return {
    customer: { name: 'Test Customer', phone: '08012345678', email: 'customer@example.com' },
    receiverName: 'Chiamaka O.',
    pickup: { address: '12 Ahmadu Bello Way, Garki', location: GARKI },
    dropoff: { address: 'Plot 14, Aminu Kano Crescent, Wuse 2', location: WUSE2 },
    item: 'Documents',
    packageSize: size,
  };
}

/** Creates an order and pays for it through the webhook path. */
export async function paidOrder(core: TestCore, size: 'small' | 'medium' | 'large' = 'small') {
  const { order, trackingToken } = await core.orders.create(orderInput(size));
  const pay = await core.payments.initiate(order.id, randomUUID());
  const w = chargeSuccess(pay.reference, order.price_kobo);
  core.fake.charges.set(pay.reference, { status: 'success', amount: order.price_kobo });
  await core.payments.handleWebhook(w.raw, w.sig);
  return { order: await core.orders.getById(order.id), trackingToken, reference: pay.reference, paymentId: pay.paymentId };
}

export async function driverByEmail(core: Core, email: string): Promise<string> {
  return (await core.db.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id;
}

/** Puts every driver offline, then the given ones online at a place, as if they just sent a location. */
export async function onlyOnline(core: Core, drivers: Array<{ email: string; lat: number; lng: number }>) {
  await core.db.query(`UPDATE drivers SET status = 'offline'`);
  for (const d of drivers) {
    await core.db.query(
      `UPDATE drivers SET status = 'available', last_seen_at = now(), last_location = $2 WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [d.email, point(d.lat, d.lng)],
    );
  }
}

export async function outboxTypes(core: Core): Promise<string[]> {
  return (await core.db.query(`SELECT type FROM outbox ORDER BY id`)).rows.map((r) => r.type);
}

export async function unbalancedGroups(core: Core): Promise<number> {
  return (await core.db.query(`SELECT entry_group FROM ledger_entries GROUP BY entry_group HAVING sum(amount_kobo) <> 0`)).rowCount ?? 0;
}

export const cmd = (orderId: string, type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  commandId: randomUUID(),
  orderId,
  type,
  occurredAt: new Date().toISOString(),
  payload,
  ...extra,
});
