import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Core } from '../core';
import { withTx } from '../db/db';

/**
 * Test-only routes for Hookstorm (enabled by HOOKSTORM_ROUTES=1, never in production).
 * reset: recreate the orders and payments the recorded webhook events refer to.
 * state: what the invariants check.
 */
interface Seed {
  orders: Array<{ key: string; payments: Array<{ reference: string; amountKobo: number }> }>;
}

const SEED_FILE = join(__dirname, '..', '..', 'hookstorm', 'seed.json');

export async function hookstormReset(core: Core, _body: unknown): Promise<{ ok: true; orders: number }> {
  const seed: Seed = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
  await withTx(core.db, async (tx) => {
    await tx.query(
      `TRUNCATE ledger_entries, refunds, payments, offers, order_events, location_points, inbox, outbox, processed_messages, orders RESTART IDENTITY CASCADE`,
    );
  });
  for (const o of seed.orders) {
    const amount = o.payments[0]!.amountKobo;
    const { order } = await core.orders.create({
      customer: { name: `Hookstorm ${o.key}`, phone: '08000000000', email: `${o.key}@example.com` },
      receiverName: 'Receiver',
      pickup: { address: 'Garki, Abuja', location: { lat: 9.0333, lng: 7.4833 } },
      dropoff: { address: 'Wuse 2, Abuja', location: { lat: 9.0765, lng: 7.4693 } },
      item: 'Test parcel',
      packageSize: 'small',
    });
    // Seeded prices must match the recorded events, so set the price directly.
    await core.db.query(`UPDATE orders SET price_kobo = $2 WHERE id = $1`, [order.id, amount]);
    for (const p of o.payments) {
      await core.db.query(
        `INSERT INTO payments (id, order_id, provider, provider_reference, idempotency_key, amount_kobo, status)
         VALUES (gen_random_uuid(), $1, 'paystack', $2, $3, $4, 'initiated')`,
        [order.id, p.reference, `hookstorm:${p.reference}`, p.amountKobo],
      );
    }
  }
  return { ok: true, orders: seed.orders.length };
}

export async function hookstormState(core: Core): Promise<any> {
  const payments = (
    await core.db.query(
      `SELECT p.provider_reference AS reference, p.status, p.role, p.amount_kobo::int AS amount, o.status AS order_status, o.id AS order_id
         FROM payments p JOIN orders o ON o.id = p.order_id`,
    )
  ).rows;
  const ledger = (
    await core.db.query(
      `SELECT p.provider_reference AS reference, l.account, l.amount_kobo::int AS amount, l.memo
         FROM ledger_entries l JOIN payments p ON p.id = l.payment_id ORDER BY l.id`,
    )
  ).rows;
  const unbalanced = (
    await core.db.query(`SELECT entry_group FROM ledger_entries GROUP BY entry_group HAVING sum(amount_kobo) <> 0`)
  ).rows;
  const orders = (await core.db.query(`SELECT id, status, version FROM orders`)).rows;
  return {
    payments: Object.fromEntries(payments.map((p) => [p.reference, p])),
    orders,
    ledger,
    unbalancedGroups: unbalanced.length,
  };
}
