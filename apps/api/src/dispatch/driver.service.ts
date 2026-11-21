import { DRIVER_HOLDS, DriverCommand, LocationBatch, LIVE_LOCATION_STATUSES, driverEarningKobo, type OrderEvent } from '@waybill/shared';
import { hashPin, safeEqualHex } from '../crypto';
import { point, withTx, type Db, type Tx } from '../db/db';
import { DomainError, conflict, forbidden, invalid, notFound } from '../errors';
import { post } from '../ledger/ledger';
import { releaseDriver } from '../orders/orders.service';
import { applyOrderEvent } from '../orders/transitions';
import { enqueue } from '../outbox/outbox';
import type { RealtimePublisher } from '../realtime/publisher';

const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_SECONDS = 600;

const SIMPLE: Partial<Record<DriverCommand['type'], OrderEvent>> = {
  start_trip: 'trip_started',
  start_dropoff: 'dropoff_started',
  report_failed_attempt: 'delivery_failed',
};

/** Commands from the driver app (ADR-0006). Every command is idempotent by commandId. */
export class DriverService {
  constructor(
    private readonly db: Db,
    private readonly realtime: RealtimePublisher,
  ) {}

  async handle(driverId: string, raw: unknown): Promise<{ order: any; replayed: boolean }> {
    const cmd = DriverCommand.parse(raw);
    const occurredAt = new Date(cmd.occurredAt);
    let pinFailure: DomainError | null = null;

    const result = await withTx(this.db, async (tx) => {
      const prior = await tx.query(`SELECT order_id FROM order_events WHERE command_id = $1`, [cmd.commandId]);
      if (prior.rowCount) return { order: await this.orderView(tx, cmd.orderId), replayed: true };

      const order = (await tx.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [cmd.orderId])).rows[0];
      if (!order) throw notFound('order not found');
      const base = { orderId: cmd.orderId, actor: 'driver' as const, actorId: driverId, commandId: cmd.commandId, occurredAt };

      if (cmd.type === 'accept_offer' || cmd.type === 'decline_offer') {
        const offer = (
          await tx.query(`SELECT *, expires_at > now() AS live FROM offers WHERE order_id = $1 AND driver_id = $2 AND status = 'pending' FOR UPDATE`, [
            cmd.orderId,
            driverId,
          ])
        ).rows[0];
        if (!offer) throw conflict('this offer is no longer open', { status: order.status, version: order.version });
        if (cmd.type === 'decline_offer') {
          await tx.query(`UPDATE offers SET status = 'declined', decided_at = now() WHERE id = $1`, [offer.id]);
          await applyOrderEvent(tx, { ...base, event: 'offer_declined', payload: { offerId: offer.id } });
          await enqueue(tx, { type: 'order.needs_driver', payload: { orderId: cmd.orderId } }, { aggregateId: cmd.orderId });
          return { order: await this.orderView(tx, cmd.orderId), replayed: false };
        }
        if (!offer.live) throw conflict('this offer has expired', { status: order.status, version: order.version });
        await tx.query(`UPDATE offers SET status = 'accepted', decided_at = now() WHERE id = $1`, [offer.id]);
        await applyOrderEvent(tx, { ...base, event: 'offer_accepted', payload: { offerId: offer.id }, patch: { driver_id: driverId, needs_attention: false } });
        await tx.query(`UPDATE drivers SET status = 'busy' WHERE user_id = $1`, [driverId]);
        await enqueue(tx, { type: 'driver.status_changed', payload: { driverId, status: 'busy' } }, { aggregateId: driverId });
        return { order: await this.orderView(tx, cmd.orderId), replayed: false };
      }

      if (order.driver_id !== driverId) throw conflict('this order is no longer assigned to you', { status: order.status, version: order.version });
      const expectedVersion = cmd.expectedVersion;

      if (cmd.type === 'confirm_pickup') {
        if (!cmd.payload.photoId) throw invalid('a pickup photo is required');
        await applyOrderEvent(tx, { ...base, expectedVersion, event: 'pickup_confirmed', payload: { photoId: cmd.payload.photoId }, patch: { pickup_photo_id: cmd.payload.photoId } });
      } else if (cmd.type === 'confirm_delivery') {
        const check = await this.checkPin(tx, order, cmd.payload.pin);
        if (check) {
          pinFailure = check;
          return null; // commit the attempt counter, then report the failure
        }
        await applyOrderEvent(tx, { ...base, expectedVersion, event: 'delivery_confirmed' });
        const price = Number(order.price_kobo);
        const earning = driverEarningKobo(price);
        await post(
          tx,
          [
            { account: 'order_liability', amountKobo: price },
            { account: `driver_payable:${driverId}`, amountKobo: -earning },
            { account: 'platform_revenue', amountKobo: -(price - earning) },
          ],
          { memo: 'delivered', orderId: order.id },
        );
        await releaseDriver(tx, driverId);
      } else if (cmd.type === 'confirm_return') {
        await applyOrderEvent(tx, { ...base, expectedVersion, event: 'return_confirmed' });
        await releaseDriver(tx, driverId);
      } else {
        const event = SIMPLE[cmd.type];
        if (!event) throw invalid(`unknown command ${cmd.type}`);
        await applyOrderEvent(tx, { ...base, expectedVersion, event, payload: cmd.payload.reason ? { reason: cmd.payload.reason } : {} });
      }
      return { order: await this.orderView(tx, cmd.orderId), replayed: false };
    });
    if (pinFailure) throw pinFailure;
    return result!;
  }

  /** Returns an error to report (after committing the attempt count), or null if the PIN is right. */
  private async checkPin(tx: Tx, order: any, pin: string | undefined): Promise<DomainError | null> {
    if (!pin) return invalid('the delivery PIN is required');
    const windowOld = !order.pin_window_started || Date.now() - new Date(order.pin_window_started).getTime() > PIN_WINDOW_SECONDS * 1000;
    const attempts = windowOld ? 0 : order.pin_failed_attempts;
    if (attempts >= PIN_MAX_ATTEMPTS) return new DomainError('locked', 'too many wrong PINs; try again in 10 minutes or call dispatch');
    if (safeEqualHex(hashPin(order.pin_salt, pin), order.pin_hash)) return null;
    await tx.query(`UPDATE orders SET pin_failed_attempts = $2, pin_window_started = $3 WHERE id = $1`, [
      order.id,
      attempts + 1,
      windowOld ? new Date() : order.pin_window_started,
    ]);
    return invalid('wrong PIN', { attemptsLeft: PIN_MAX_ATTEMPTS - attempts - 1 });
  }

  async setAvailability(driverId: string, status: 'available' | 'offline'): Promise<any> {
    return withTx(this.db, async (tx) => {
      const d = (await tx.query(`SELECT status FROM drivers WHERE user_id = $1 FOR UPDATE`, [driverId])).rows[0];
      if (!d) throw notFound('driver not found');
      if (d.status === 'busy') throw conflict('finish your current delivery first');
      if (status === 'offline') {
        const pending = await tx.query(`SELECT 1 FROM offers WHERE driver_id = $1 AND status = 'pending'`, [driverId]);
        if (pending.rowCount) throw conflict('answer the open offer first');
      }
      if (d.status !== status) {
        await tx.query(`UPDATE drivers SET status = $2, idle_since = now() WHERE user_id = $1`, [driverId, status]);
        await enqueue(tx, { type: 'driver.status_changed', payload: { driverId, status } }, { aggregateId: driverId });
      }
      return { status };
    });
  }

  /** Everything the app needs to resume: the driver, their open offer, and their active order. */
  async current(driverId: string): Promise<any> {
    const driver = (
      await this.db.query(
        `SELECT d.user_id AS id, u.name, d.status, d.vehicle FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = $1`,
        [driverId],
      )
    ).rows[0];
    if (!driver) throw notFound('driver not found');
    const offer = (
      await this.db.query(`SELECT id, order_id, expires_at FROM offers WHERE driver_id = $1 AND status = 'pending' AND expires_at > now()`, [driverId])
    ).rows[0];
    const active = (await this.db.query(`SELECT id FROM orders WHERE driver_id = $1 AND status = ANY($2) ORDER BY updated_at DESC LIMIT 1`, [driverId, DRIVER_HOLDS]))
      .rows[0];
    return {
      driver,
      offer: offer ? { id: offer.id, expiresAt: offer.expires_at, order: await this.orderView(this.db, offer.order_id, { forOffer: true }) } : null,
      order: active ? await this.orderView(this.db, active.id) : null,
    };
  }

  private async orderView(q: Pick<Tx, 'query'>, orderId: string, opts: { forOffer?: boolean } = {}): Promise<any> {
    const o = (
      await q.query(
        `SELECT o.id, o.status, o.version, o.item, o.package_size, o.receiver_name, o.customer_name, o.customer_phone,
                o.pickup_address, ST_Y(o.pickup_location::geometry) AS pickup_lat, ST_X(o.pickup_location::geometry) AS pickup_lng,
                o.dropoff_address, ST_Y(o.dropoff_location::geometry) AS dropoff_lat, ST_X(o.dropoff_location::geometry) AS dropoff_lng,
                o.distance_meters, o.price_kobo::int AS price_kobo, o.pin_salt, o.pin_hash, o.cancel_reason, o.driver_id
           FROM orders o WHERE o.id = $1`,
        [orderId],
      )
    ).rows[0];
    if (!o) return null;
    const { pin_salt, pin_hash, customer_phone, ...rest } = o;
    return {
      ...rest,
      earningKobo: driverEarningKobo(o.price_kobo),
      // Only the assigned driver gets the PIN check data and the customer's phone number.
      ...(opts.forOffer ? {} : { pinCheck: { salt: pin_salt, hash: pin_hash }, customerPhone: customer_phone }),
    };
  }

  /** Location batches (ADR-0003): history in Postgres, latest point on the driver, live fan-out via Redis. */
  async ingestLocations(driverId: string, raw: unknown): Promise<{ accepted: number; live: boolean }> {
    const { points } = LocationBatch.parse(raw);
    const sorted = [...points].sort((a, b) => a.seq - b.seq);
    const out = await withTx(this.db, async (tx) => {
      const d = (await tx.query(`SELECT last_seq FROM drivers WHERE user_id = $1 FOR UPDATE`, [driverId])).rows[0];
      if (!d) throw forbidden('not a driver');
      let accepted = 0;
      for (const p of sorted) {
        const r = await tx.query(
          `INSERT INTO location_points (driver_id, order_id, seq, recorded_at, location, accuracy, speed, heading)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (driver_id, seq) DO NOTHING`,
          [driverId, p.orderId ?? null, p.seq, p.recordedAt, point(p.lat, p.lng), p.accuracy ?? null, p.speed ?? null, p.heading ?? null],
        );
        accepted += r.rowCount ?? 0;
      }
      const newest = sorted[sorted.length - 1]!;
      if (newest.seq <= Number(d.last_seq)) return { accepted, newest: null };
      await tx.query(`UPDATE drivers SET last_location = $2, last_seen_at = now(), last_seq = $3 WHERE user_id = $1`, [
        driverId,
        point(newest.lat, newest.lng),
        newest.seq,
      ]);
      const active = (await tx.query(`SELECT id, status FROM orders WHERE driver_id = $1 AND status = ANY($2) LIMIT 1`, [driverId, DRIVER_HOLDS])).rows[0];
      return { accepted, newest, active };
    });

    const fresh = out.newest && Date.now() - new Date(out.newest.recordedAt).getTime() < 30_000;
    if (out.newest && fresh) {
      const msg = { type: 'location' as const, driverId, lat: out.newest.lat, lng: out.newest.lng, recordedAt: out.newest.recordedAt, seq: out.newest.seq };
      await this.realtime.publish('dispatch', { ...msg, orderId: out.active?.id });
      if (out.active && LIVE_LOCATION_STATUSES.includes(out.active.status)) await this.realtime.publish(`order:${out.active.id}`, { ...msg, orderId: out.active.id });
    }
    return { accepted: out.accepted, live: Boolean(fresh) };
  }

  async savePhoto(driverId: string, id: string, mime: string, bytes: Buffer): Promise<void> {
    if (!/^[\w-]{8,100}$/.test(id)) throw invalid('bad photo id');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw invalid('photo must be jpeg, png or webp');
    if (bytes.length > 3 * 1024 * 1024) throw invalid('photo too large');
    await this.db.query(`INSERT INTO photos (id, driver_id, mime, bytes) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, [id, driverId, mime, bytes]);
  }
}
