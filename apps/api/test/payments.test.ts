import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { chargeSuccess, makeCore, orderInput, outboxTypes, paidOrder, refundProcessed, resetDb, unbalancedGroups, type TestCore } from './helpers';

let core: TestCore;
beforeEach(async () => {
  await core?.close();
  await resetDb();
  core = makeCore();
});
afterAll(async () => core?.close());

describe('payments (ADR-0004)', () => {
  it('initiate is idempotent per key', async () => {
    const { order } = await core.orders.create(orderInput());
    const key = randomUUID();
    const a = await core.payments.initiate(order.id, key);
    const b = await core.payments.initiate(order.id, key);
    expect(b).toEqual(a);
    expect((await core.db.query(`SELECT count(*)::int AS n FROM payments`)).rows[0].n).toBe(1);
  });

  it('a verified charge.success pays the order once, with a balanced ledger', async () => {
    const { order, reference } = await paidOrder(core);
    expect(order.status).toBe('PAID');
    const pay = (await core.db.query(`SELECT status, role FROM payments WHERE provider_reference = $1`, [reference])).rows[0];
    expect(pay).toEqual({ status: 'succeeded', role: 'primary' });
    expect(await unbalancedGroups(core)).toBe(0);
    expect(await outboxTypes(core)).toContain('order.paid');
  });

  it('rejects a bad signature', async () => {
    const { order } = await core.orders.create(orderInput());
    const pay = await core.payments.initiate(order.id, randomUUID());
    const w = chargeSuccess(pay.reference, order.price_kobo);
    await expect(core.payments.handleWebhook(w.raw, 'deadbeef')).rejects.toThrow(/signature/);
  });

  it('20 concurrent copies of the same webhook pay once', async () => {
    const { order } = await core.orders.create(orderInput());
    const pay = await core.payments.initiate(order.id, randomUUID());
    const w = chargeSuccess(pay.reference, order.price_kobo);
    const results = await Promise.all(Array.from({ length: 20 }, () => core.payments.handleWebhook(w.raw, w.sig)));
    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    const ledger = await core.db.query(`SELECT count(DISTINCT entry_group)::int AS n FROM ledger_entries WHERE order_id = $1`, [order.id]);
    expect(ledger.rows[0].n).toBe(1);
    expect((await core.orders.getById(order.id)).status).toBe('PAID');
  });

  it('a second successful payment for the same order is refunded, not counted (F6)', async () => {
    const { order } = await core.orders.create(orderInput());
    const a = await core.payments.initiate(order.id, randomUUID());
    const b = await core.payments.initiate(order.id, randomUUID());
    for (const ref of [a.reference, b.reference]) {
      core.fake.charges.set(ref, { status: 'success', amount: order.price_kobo });
      const w = chargeSuccess(ref, order.price_kobo, ref === a.reference ? 1 : 2);
      await core.payments.handleWebhook(w.raw, w.sig);
    }
    const rows = (await core.db.query(`SELECT provider_reference, role FROM payments ORDER BY created_at`)).rows;
    expect(rows.map((r) => r.role).sort()).toEqual(['extra', 'primary']);
    expect((await outboxTypes(core)).filter((t) => t === 'payment.refund_required')).toHaveLength(1);

    const extra = rows.find((r) => r.role === 'extra')!;
    const pid = (await core.db.query(`SELECT id FROM payments WHERE provider_reference = $1`, [extra.provider_reference])).rows[0].id;
    await core.payments.refund(pid, 'duplicate');
    await core.payments.refund(pid, 'duplicate'); // redelivered message
    expect(core.fake.refundCalls).toEqual([extra.provider_reference]);
    const w = refundProcessed(extra.provider_reference, order.price_kobo);
    await core.payments.handleWebhook(w.raw, w.sig);
    expect((await core.db.query(`SELECT status FROM payments WHERE id = $1`, [pid])).rows[0].status).toBe('refunded');
    expect(await unbalancedGroups(core)).toBe(0);
  });

  it('a refund delivered before its charge leaves the payment refunded and the order cancelled', async () => {
    const { order } = await core.orders.create(orderInput());
    const pay = await core.payments.initiate(order.id, randomUUID());
    const r = refundProcessed(pay.reference, order.price_kobo);
    await core.payments.handleWebhook(r.raw, r.sig);
    const c = chargeSuccess(pay.reference, order.price_kobo);
    await core.payments.handleWebhook(c.raw, c.sig); // late charge.success: must not undo the refund
    expect((await core.db.query(`SELECT status FROM payments WHERE id = $1`, [pay.paymentId])).rows[0].status).toBe('refunded');
    expect((await core.orders.getById(order.id)).status).toBe('CANCELLED');
    expect(await unbalancedGroups(core)).toBe(0);
  });

  it('the reconciler completes a payment whose webhook never came (F7)', async () => {
    const { order } = await core.orders.create(orderInput());
    const pay = await core.payments.initiate(order.id, randomUUID());
    core.fake.charges.set(pay.reference, { status: 'success', amount: order.price_kobo });
    const r = await core.payments.reconcile();
    expect(r.succeeded).toBe(1);
    expect((await core.orders.getById(order.id)).status).toBe('PAID');
    // The webhook finally arriving changes nothing.
    const w = chargeSuccess(pay.reference, order.price_kobo);
    await core.payments.handleWebhook(w.raw, w.sig);
    expect((await core.db.query(`SELECT count(DISTINCT entry_group)::int AS n FROM ledger_entries`)).rows[0].n).toBe(1);
  });

  it('expires an unpaid order after the payment window', async () => {
    await core.close();
    core = makeCore({ paymentExpirySeconds: 0 });
    const { order } = await core.orders.create(orderInput());
    await core.payments.initiate(order.id, randomUUID());
    await core.payments.reconcile();
    expect((await core.orders.getById(order.id)).status).toBe('EXPIRED');
  });

  it('a payment that lands after the order expired is refunded', async () => {
    await core.close();
    core = makeCore({ paymentExpirySeconds: 0 });
    const { order } = await core.orders.create(orderInput());
    const pay = await core.payments.initiate(order.id, randomUUID());
    await core.payments.reconcile();
    const w = chargeSuccess(pay.reference, order.price_kobo);
    await core.payments.handleWebhook(w.raw, w.sig);
    expect((await core.db.query(`SELECT role FROM payments WHERE id = $1`, [pay.paymentId])).rows[0].role).toBe('extra');
    expect(await outboxTypes(core)).toContain('payment.refund_required');
  });

  it('an amount that does not match the order is refunded, not accepted', async () => {
    const { order } = await core.orders.create(orderInput());
    const pay = await core.payments.initiate(order.id, randomUUID());
    const w = chargeSuccess(pay.reference, 100);
    await core.payments.handleWebhook(w.raw, w.sig);
    expect((await core.orders.getById(order.id)).status).toBe('AWAITING_PAYMENT');
    expect((await core.db.query(`SELECT role FROM payments WHERE id = $1`, [pay.paymentId])).rows[0].role).toBe('extra');
  });
});
