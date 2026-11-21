import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pinFromToken } from '../src/crypto';
import { cmd, driverByEmail, makeCore, onlyOnline, outboxTypes, paidOrder, resetDb, unbalancedGroups, type TestCore } from './helpers';

let core: TestCore;
beforeEach(async () => {
  await core?.close();
  await resetDb();
  core = makeCore();
});
afterAll(async () => core?.close());

const MUSA = 'musa@drivers.waybill.test'; // car
const IFEOMA = 'ifeoma@drivers.waybill.test'; // van
const ADE = 'ade@drivers.waybill.test'; // bike

describe('assignment (ADR-0002)', () => {
  it('offers to the nearest driver whose vehicle fits', async () => {
    await onlyOnline(core, [
      { email: ADE, lat: 9.0335, lng: 7.4835 }, // closest, but a bike
      { email: MUSA, lat: 9.04, lng: 7.49 },
      { email: IFEOMA, lat: 9.07, lng: 7.5 },
    ]);
    const { order } = await paidOrder(core, 'medium');
    expect(await core.assignment.tryAssign(order.id)).toBe('offered');
    const offer = (await core.db.query(`SELECT driver_id, status FROM offers WHERE order_id = $1`, [order.id])).rows[0];
    expect(offer).toEqual({ driver_id: await driverByEmail(core, MUSA), status: 'pending' });
    expect((await core.orders.getById(order.id)).status).toBe('OFFERED');
    // Calling again doesn't create a second offer.
    expect(await core.assignment.tryAssign(order.id)).toBe('not_needed');
  });

  it('accepting assigns the order; the expiry check afterwards is a no-op', async () => {
    await onlyOnline(core, [{ email: MUSA, lat: 9.04, lng: 7.49 }]);
    const { order } = await paidOrder(core);
    await core.assignment.tryAssign(order.id);
    const musa = await driverByEmail(core, MUSA);
    const offer = (await core.db.query(`SELECT id FROM offers WHERE order_id = $1`, [order.id])).rows[0];
    await core.drivers.handle(musa, cmd(order.id, 'accept_offer'));
    expect(await core.assignment.expireOffer(offer.id)).toBe('not_pending');
    const o = await core.orders.getById(order.id);
    expect([o.status, o.driver_id]).toEqual(['ASSIGNED', musa]);
    expect((await core.db.query(`SELECT status FROM drivers WHERE user_id = $1`, [musa])).rows[0].status).toBe('busy');
  });

  it('an accept racing the expiry leaves exactly one outcome', async () => {
    await core.close();
    core = makeCore({ offerTtlSeconds: 0 });
    await onlyOnline(core, [{ email: MUSA, lat: 9.04, lng: 7.49 }]);
    const { order } = await paidOrder(core);
    await core.assignment.tryAssign(order.id);
    const musa = await driverByEmail(core, MUSA);
    const offer = (await core.db.query(`SELECT id FROM offers WHERE order_id = $1`, [order.id])).rows[0];
    const [accept, expire] = await Promise.allSettled([core.drivers.handle(musa, cmd(order.id, 'accept_offer')), core.assignment.expireOffer(offer.id)]);
    // TTL 0: the offer is already past its expiry, so the accept must lose.
    expect(accept.status).toBe('rejected');
    expect(expire).toEqual({ status: 'fulfilled', value: 'expired' });
    expect((await core.orders.getById(order.id)).status).toBe('PAID');
  });

  it('a decline moves on to the next driver', async () => {
    await onlyOnline(core, [
      { email: MUSA, lat: 9.034, lng: 7.484 },
      { email: IFEOMA, lat: 9.06, lng: 7.49 },
    ]);
    const { order } = await paidOrder(core);
    await core.assignment.tryAssign(order.id);
    await core.drivers.handle(await driverByEmail(core, MUSA), cmd(order.id, 'decline_offer'));
    expect((await core.orders.getById(order.id)).status).toBe('PAID');
    expect(await core.assignment.tryAssign(order.id)).toBe('offered');
    const offers = (await core.db.query(`SELECT driver_id, status FROM offers WHERE order_id = $1 ORDER BY created_at`, [order.id])).rows;
    expect(offers.map((o) => o.status)).toEqual(['declined', 'pending']);
    expect(offers[1].driver_id).toBe(await driverByEmail(core, IFEOMA));
  });

  it('two orders paid at once never offer the same driver twice', async () => {
    await onlyOnline(core, [{ email: MUSA, lat: 9.04, lng: 7.49 }]);
    const a = await paidOrder(core);
    const b = await paidOrder(core);
    const results = await Promise.all([core.assignment.tryAssign(a.order.id), core.assignment.tryAssign(b.order.id)]);
    expect(results.sort()).toEqual(['no_driver', 'offered']);
  });

  it('cancels and refunds a paid order nobody takes within the SLA (F5)', async () => {
    await core.close();
    core = makeCore({ assignmentSlaSeconds: 0, assignmentAlertSeconds: 0 });
    await onlyOnline(core, []);
    const { order } = await paidOrder(core);
    expect(await core.assignment.tryAssign(order.id)).toBe('no_driver');
    expect(await core.assignment.assignmentCheck(order.id)).toBe('cancelled');
    const o = await core.orders.getById(order.id);
    expect([o.status, o.cancel_reason]).toEqual(['CANCELLED', 'no driver available']);
    expect(await outboxTypes(core)).toContain('payment.refund_required');
    expect(await core.assignment.assignmentCheck(order.id)).toBe('ok'); // the second scheduled check is harmless
    expect(await unbalancedGroups(core)).toBe(0);
  });

  it('dispatcher can assign directly, withdrawing the open offer', async () => {
    await onlyOnline(core, [
      { email: MUSA, lat: 9.034, lng: 7.484 },
      { email: IFEOMA, lat: 9.06, lng: 7.49 },
    ]);
    const { order } = await paidOrder(core);
    await core.assignment.tryAssign(order.id);
    const ifeoma = await driverByEmail(core, IFEOMA);
    await core.assignment.dispatcherAssign(order.id, ifeoma, 'dispatcher-1');
    const o = await core.orders.getById(order.id);
    expect([o.status, o.driver_id]).toEqual(['ASSIGNED', ifeoma]);
    const offer = (await core.db.query(`SELECT status FROM offers WHERE order_id = $1`, [order.id])).rows[0];
    expect(offer.status).toBe('withdrawn');
  });
});

describe('driver commands (ADR-0006)', () => {
  async function assigned() {
    await onlyOnline(core, [{ email: MUSA, lat: 9.04, lng: 7.49 }]);
    const paid = await paidOrder(core);
    await core.assignment.tryAssign(paid.order.id);
    const musa = await driverByEmail(core, MUSA);
    await core.drivers.handle(musa, cmd(paid.order.id, 'accept_offer'));
    return { ...paid, musa };
  }

  it('runs pickup to delivery and books the driver earning', async () => {
    const { order, trackingToken, musa } = await assigned();
    await core.drivers.handle(musa, cmd(order.id, 'start_trip'));
    await core.drivers.handle(musa, cmd(order.id, 'confirm_pickup', { photoId: 'photo-abc-123' }));
    await core.drivers.handle(musa, cmd(order.id, 'start_dropoff'));
    const pin = pinFromToken(core.config.pinSecret, trackingToken);
    const r = await core.drivers.handle(musa, cmd(order.id, 'confirm_delivery', { pin }));
    expect(r.order.status).toBe('DELIVERED');
    const ledger = (await core.db.query(`SELECT account, sum(amount_kobo)::int AS s FROM ledger_entries WHERE order_id = $1 GROUP BY account`, [order.id])).rows;
    const by = Object.fromEntries(ledger.map((l) => [l.account, l.s]));
    expect(by.order_liability).toBe(0);
    expect(by[`driver_payable:${musa}`]).toBeLessThan(0);
    expect((await core.db.query(`SELECT status FROM drivers WHERE user_id = $1`, [musa])).rows[0].status).toBe('available');
    const view = await core.orders.getForTracking(trackingToken);
    expect(view.timeline.map((e: any) => e.to)).toEqual([
      'AWAITING_PAYMENT', 'PAID', 'OFFERED', 'ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'PICKED_UP', 'EN_ROUTE_TO_DROPOFF', 'DELIVERED',
    ]);
  });

  it('a replayed command returns the original result instead of applying twice', async () => {
    const { order, musa } = await assigned();
    const c = cmd(order.id, 'start_trip');
    const first = await core.drivers.handle(musa, c);
    const again = await core.drivers.handle(musa, c);
    expect(again.replayed).toBe(true);
    expect(again.order.version).toBe(first.order.version);
    expect((await core.db.query(`SELECT count(*)::int AS n FROM order_events WHERE command_id = $1`, [c.commandId])).rows[0].n).toBe(1);
  });

  it('wrong PINs are counted and locked out after 5', async () => {
    const { order, musa, trackingToken } = await assigned();
    await core.drivers.handle(musa, cmd(order.id, 'start_trip'));
    await core.drivers.handle(musa, cmd(order.id, 'confirm_pickup', { photoId: 'photo-abc-123' }));
    await core.drivers.handle(musa, cmd(order.id, 'start_dropoff'));
    const pin = pinFromToken(core.config.pinSecret, trackingToken);
    const wrong = ['0000', '1111', '2222', '3333', '4444', '5555'].filter((p) => p !== pin).slice(0, 5);
    for (const p of wrong) await expect(core.drivers.handle(musa, cmd(order.id, 'confirm_delivery', { pin: p }))).rejects.toMatchObject({ code: expect.stringMatching(/invalid|locked/) });
    // Even the right PIN is refused while locked.
    await expect(core.drivers.handle(musa, cmd(order.id, 'confirm_delivery', { pin }))).rejects.toMatchObject({ code: 'locked' });
  });

  it('a pickup made offline after dispatch cancelled is rejected, with the current state (F9)', async () => {
    const { order, musa } = await assigned();
    const started = await core.drivers.handle(musa, cmd(order.id, 'start_trip'));
    await core.orders.cancel(order.id, 'dispatcher', 'dispatcher-1', 'customer called to cancel');
    const err = await core.drivers
      .handle(musa, cmd(order.id, 'confirm_pickup', { photoId: 'photo-abc-123' }, { expectedVersion: started.order.version }))
      .catch((e) => e);
    expect(err.code).toBe('conflict');
    expect(err.details.status).toBe('CANCELLED');
    expect((await core.db.query(`SELECT status FROM drivers WHERE user_id = $1`, [musa])).rows[0].status).toBe('available');
    expect(await outboxTypes(core)).toContain('payment.refund_required');
  });

  it('a stale expectedVersion is a conflict, never an overwrite', async () => {
    const { order, musa } = await assigned();
    const v = (await core.orders.getById(order.id)).version;
    await core.drivers.handle(musa, cmd(order.id, 'start_trip'));
    const err = await core.drivers.handle(musa, cmd(order.id, 'confirm_pickup', { photoId: 'photo-abc-123' }, { expectedVersion: v })).catch((e) => e);
    expect(err.code).toBe('conflict');
  });

  it('another driver cannot act on the order', async () => {
    const { order } = await assigned();
    const ade = await driverByEmail(core, ADE);
    await expect(core.drivers.handle(ade, cmd(order.id, 'start_trip'))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('location batches keep history, ignore old sequence numbers, and only go live on the delivery leg', async () => {
    const { order, musa } = await assigned();
    const now = Date.now();
    const pts = (seqs: number[]) => ({ points: seqs.map((s) => ({ seq: s, recordedAt: new Date(now + s).toISOString(), lat: 9.05, lng: 7.48 + s / 1e4 })) });
    await core.drivers.ingestLocations(musa, pts([1, 2, 3]));
    await core.drivers.ingestLocations(musa, pts([2, 3])); // replayed batch
    expect((await core.db.query(`SELECT count(*)::int AS n FROM location_points WHERE driver_id = $1`, [musa])).rows[0].n).toBe(3);
    expect(core.published.sent.some((s) => s.room === `order:${order.id}`)).toBe(false); // not picked up yet
    await core.drivers.handle(musa, cmd(order.id, 'start_trip'));
    await core.drivers.handle(musa, cmd(order.id, 'confirm_pickup', { photoId: 'photo-abc-123' }));
    await core.drivers.ingestLocations(musa, pts([4]));
    expect(core.published.sent.some((s) => s.room === `order:${order.id}`)).toBe(true);
  });
});
