import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Rabbit } from '../src/mq/rabbit';
import { OutboxRelay } from '../src/outbox/relay';
import { consumers } from '../src/worker';
import { cmd, driverByEmail, makeCore, onlyOnline, paidOrder, resetDb, TEST_DB_URL, type TestCore } from './helpers';

// Uses a separate RabbitMQ vhost so a running dev worker doesn't steal the messages.
const MGMT = 'http://guest:guest@127.0.0.1:15672/api';
const VHOST = 'waybill_test';
const AMQP = `amqp://guest:guest@127.0.0.1:55672/${VHOST}`;

async function freshVhost() {
  const auth = { Authorization: `Basic ${Buffer.from('guest:guest').toString('base64')}`, 'content-type': 'application/json' };
  await fetch(`${MGMT.replace('guest:guest@', '')}/vhosts/${VHOST}`, { method: 'DELETE', headers: auth });
  await fetch(`${MGMT.replace('guest:guest@', '')}/vhosts/${VHOST}`, { method: 'PUT', headers: auth });
  await fetch(`${MGMT.replace('guest:guest@', '')}/permissions/${VHOST}/guest`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ configure: '.*', write: '.*', read: '.*' }),
  });
}

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

let core: TestCore;
let rabbit: Rabbit;
let relay: OutboxRelay;

beforeAll(async () => {
  await resetDb();
  await freshVhost();
  core = makeCore({ offerTtlSeconds: 2 });
  rabbit = new Rabbit(AMQP);
  await rabbit.connect();
  for (const spec of consumers(core)) await rabbit.consume(core.db, spec);
  relay = new OutboxRelay(core.db, rabbit, TEST_DB_URL, { pollMs: 200 });
  await relay.start();
});

afterAll(async () => {
  await relay?.stop();
  await rabbit?.close();
  await core?.close();
});

describe('outbox → RabbitMQ → consumers (ADR-0005)', () => {
  it('a paid order is offered to a driver with no other trigger than the event', async () => {
    await onlyOnline(core, [{ email: 'musa@drivers.waybill.test', lat: 9.04, lng: 7.49 }]);
    const { order } = await paidOrder(core);
    await until(async () => (await core.orders.getById(order.id)).status === 'OFFERED');
    expect(core.published.sent.some((s) => s.msg.type === 'offer')).toBe(true);
    await until(async () => (await core.db.query(`SELECT 1 FROM outbox WHERE published_at IS NULL`)).rowCount === 0);
  });

  it('an unanswered offer expires through the delay queue and goes to the next driver', async () => {
    await onlyOnline(core, [
      { email: 'halima@drivers.waybill.test', lat: 9.034, lng: 7.484 },
      { email: 'ade@drivers.waybill.test', lat: 9.06, lng: 7.49 },
    ]);
    const { order } = await paidOrder(core);
    const halima = await driverByEmail(core, 'halima@drivers.waybill.test');
    await until(async () => (await core.db.query(`SELECT 1 FROM offers WHERE order_id = $1 AND driver_id = $2`, [order.id, halima])).rowCount);
    const offers = await until(async () => {
      const r = await core.db.query(`SELECT status FROM offers WHERE order_id = $1 ORDER BY created_at`, [order.id]);
      return r.rows.length === 2 ? r.rows : null;
    }, 20_000);
    expect(offers.map((o: any) => o.status)).toEqual(['expired', 'pending']);
  });

  it('a message published twice (relay crashed before marking it) is handled once', async () => {
    await onlyOnline(core, []);
    const { order } = await paidOrder(core);
    const row = await until(async () => (await core.db.query(`SELECT message_id, type, payload FROM outbox WHERE type = 'order.paid' AND payload->>'orderId' = $1 AND published_at IS NOT NULL`, [order.id])).rows[0]);
    await rabbit.publish(row.type, row.message_id, row.payload);
    await rabbit.publish(row.type, row.message_id, row.payload);
    await new Promise((r) => setTimeout(r, 1_000));
    const n = (await core.db.query(`SELECT count(*)::int AS n FROM processed_messages WHERE consumer = 'dispatch.assignment' AND message_id = $1`, [row.message_id])).rows[0].n;
    expect(n).toBe(1);
  });

  it('cancelling a paid order refunds it through the refunds consumer', async () => {
    await onlyOnline(core, []);
    const { order, paymentId } = await paidOrder(core);
    await core.orders.cancel(order.id, 'customer', undefined, 'changed my mind');
    await until(async () => (await core.db.query(`SELECT status FROM payments WHERE id = $1`, [paymentId])).rows[0].status === 'refund_pending');
    expect(core.fake.refundCalls.length).toBeGreaterThan(0);
  });

  it('the driver hears about status changes through realtime fan-out', async () => {
    await onlyOnline(core, [{ email: 'tunde@drivers.waybill.test', lat: 9.04, lng: 7.49 }]);
    const tunde = await driverByEmail(core, 'tunde@drivers.waybill.test');
    const { order } = await paidOrder(core);
    await until(async () => (await core.orders.getById(order.id)).status === 'OFFERED');
    await core.drivers.handle(tunde, cmd(order.id, 'accept_offer'));
    await until(async () => core.published.sent.some((s) => s.room === `driver:${tunde}` && s.msg.type === 'order' && (s.msg as any).status === 'ASSIGNED'));
  });
});
