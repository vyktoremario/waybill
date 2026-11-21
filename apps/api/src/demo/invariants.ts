import { driverEarningKobo } from '@waybill/shared';
import { loadConfig } from '../config';
import { createPool, type Db } from '../db/db';

/**
 * The invariant checker (SPEC §8). Run after the failure demo, or any time: `pnpm --filter @waybill/api invariants`.
 * Each check returns the rows that violate it; an empty list means it holds.
 */
export interface CheckResult {
  name: string;
  violations: string[];
}

const CONSUMERS: Record<string, string[]> = {
  'dispatch.assignment': ['order.paid', 'order.needs_driver', 'offer.expire_check', 'order.assignment_check', 'driver.status_changed'],
  'payments.refunds': ['payment.refund_required'],
  'realtime.fanout': ['order.status_changed', 'offer.created', 'driver.status_changed'],
};

export async function checkInvariants(db: Db, opts: { slaSeconds: number }): Promise<CheckResult[]> {
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const results: CheckResult[] = [];
  const add = (name: string, violations: string[]) => results.push({ name, violations });

  // 1. No lost orders: every order's event chain is complete (seq 0..version, no gaps).
  add(
    'no lost orders: every order has a complete event history',
    (
      await q(`SELECT o.id, o.version, count(e.*)::int AS n, COALESCE(max(e.seq), -1) AS top
                 FROM orders o LEFT JOIN order_events e ON e.order_id = o.id
                GROUP BY o.id HAVING count(e.*) <> o.version + 1 OR COALESCE(max(e.seq), -1) <> o.version`)
    ).map((r) => `order ${r.id}: version ${r.version} but ${r.n} events (max seq ${r.top})`),
  );

  // 2. No double charges.
  add(
    'no double charges: at most one payment counts per order',
    (await q(`SELECT order_id, count(*)::int AS n FROM payments WHERE role = 'primary' GROUP BY order_id HAVING count(*) > 1`)).map(
      (r) => `order ${r.order_id} has ${r.n} primary payments`,
    ),
  );
  add(
    'no double charges: every extra or cancelled payment is refunded',
    (
      await q(`SELECT p.provider_reference, p.status, p.role, o.status AS order_status
                 FROM payments p JOIN orders o ON o.id = p.order_id
                WHERE p.status IN ('succeeded', 'refund_pending')
                  AND (p.role = 'extra' OR (p.role = 'primary' AND o.status IN ('CANCELLED', 'EXPIRED')))`)
    ).map((r) => `${r.provider_reference} (${r.role}, order ${r.order_status}) is ${r.status}, not refunded`),
  );
  add(
    'no double charges: money kept per order is at most its price',
    (
      await q(`SELECT o.id, o.price_kobo::int AS price, COALESCE(sum(p.amount_kobo) FILTER (WHERE p.status = 'succeeded'), 0)::int AS kept
                 FROM orders o LEFT JOIN payments p ON p.order_id = o.id GROUP BY o.id
               HAVING COALESCE(sum(p.amount_kobo) FILTER (WHERE p.status = 'succeeded'), 0) > o.price_kobo`)
    ).map((r) => `order ${r.id}: kept ${r.kept} kobo for a ${r.price} kobo order`),
  );

  // 3. Paid orders end up delivered, in progress, or cancelled and refunded; none silently stuck.
  add(
    'paid orders are never stuck waiting for a driver past the SLA',
    (
      await q(`SELECT id, status FROM orders WHERE status IN ('PAID', 'OFFERED') AND paid_at < now() - make_interval(secs => $1)`, [opts.slaSeconds + 30])
    ).map((r) => `order ${r.id} still ${r.status} after the SLA`),
  );

  // 4. The books balance.
  add(
    'ledger: every entry group sums to zero',
    (await q(`SELECT entry_group, sum(amount_kobo)::int AS s FROM ledger_entries GROUP BY entry_group HAVING sum(amount_kobo) <> 0`)).map(
      (r) => `group ${r.entry_group} sums to ${r.s}`,
    ),
  );
  add(
    'ledger: finished orders owe the customer nothing',
    (
      await q(`SELECT o.id, o.status, sum(l.amount_kobo)::int AS s FROM orders o JOIN ledger_entries l ON l.order_id = o.id AND l.account = 'order_liability'
                WHERE o.status IN ('DELIVERED', 'CANCELLED') GROUP BY o.id, o.status HAVING sum(l.amount_kobo) <> 0`)
    ).map((r) => `order ${r.id} (${r.status}) has order_liability ${r.s}`),
  );
  const delivered = await q(`SELECT driver_id, price_kobo::int AS price FROM orders WHERE status = 'DELIVERED'`);
  const owed = new Map<string, number>();
  for (const d of delivered) owed.set(d.driver_id, (owed.get(d.driver_id) ?? 0) + driverEarningKobo(d.price));
  const booked = await q(`SELECT substring(account from 16) AS driver_id, -sum(amount_kobo)::int AS s FROM ledger_entries WHERE account LIKE 'driver_payable:%' GROUP BY account`);
  const bookedMap = new Map(booked.map((b) => [b.driver_id as string, Number(b.s)]));
  const drivers = new Set([...owed.keys(), ...bookedMap.keys()]);
  add(
    'ledger: driver earnings match delivered orders',
    [...drivers].filter((d) => (owed.get(d) ?? 0) !== (bookedMap.get(d) ?? 0)).map((d) => `driver ${d}: booked ${bookedMap.get(d) ?? 0}, expected ${owed.get(d) ?? 0}`),
  );
  add(
    'refunds: the provider was asked at most once per payment',
    (await q(`SELECT payment_id, count(*)::int AS n FROM refunds GROUP BY payment_id HAVING count(*) > 1`)).map((r) => `payment ${r.payment_id}: ${r.n} refunds`),
  );

  // 5. Every event got out and was handled by every consumer that listens for it.
  add(
    'events: the outbox is fully published',
    (await q(`SELECT id, type, created_at FROM outbox WHERE published_at IS NULL`)).map((r) => `outbox ${r.id} (${r.type}) unpublished since ${r.created_at.toISOString?.() ?? r.created_at}`),
  );
  const missing: string[] = [];
  for (const [consumer, types] of Object.entries(CONSUMERS)) {
    const rows = await q(
      `SELECT o.type, o.message_id FROM outbox o
        WHERE o.type = ANY($1) AND o.published_at IS NOT NULL AND o.delay_ms = 0
          AND NOT EXISTS (SELECT 1 FROM processed_messages m WHERE m.consumer = $2 AND m.message_id = o.message_id)`,
      [types, consumer],
    );
    for (const r of rows) missing.push(`${consumer} never handled ${r.type} ${r.message_id}`);
  }
  add('events: every published event was handled by each of its consumers', missing);

  return results;
}

export function printResults(results: CheckResult[]): boolean {
  let ok = true;
  for (const r of results) {
    if (r.violations.length === 0) console.log(`  ✓ ${r.name}`);
    else {
      ok = false;
      console.log(`  ✗ ${r.name}`);
      for (const v of r.violations.slice(0, 10)) console.log(`      ${v}`);
      if (r.violations.length > 10) console.log(`      … and ${r.violations.length - 10} more`);
    }
  }
  return ok;
}

if (require.main === module) {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);
  checkInvariants(db, { slaSeconds: config.assignmentSlaSeconds })
    .then((r) => {
      console.log('Invariants:');
      const ok = printResults(r);
      return db.end().then(() => process.exit(ok ? 0 : 1));
    })
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
