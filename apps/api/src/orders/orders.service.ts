import { CreateOrderInput, LIVE_LOCATION_STATUSES, isPaidPrePickup, quoteKobo, type Actor, type OrderStatus } from '@waybill/shared';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import type { Config } from '../config';
import { hashPin, newTrackingToken, pinFromToken, sha256 } from '../crypto';
import { point, withTx, type Db, type Tx } from '../db/db';
import { notFound } from '../errors';
import { post } from '../ledger/ledger';
import { enqueue } from '../outbox/outbox';
import { applyOrderEvent, recordCreated, type OrderRow } from './transitions';

export const ORDER_COLUMNS = `
  o.id, o.status, o.version, o.customer_name, o.customer_phone, o.customer_email, o.receiver_name,
  o.pickup_address, ST_Y(o.pickup_location::geometry) AS pickup_lat, ST_X(o.pickup_location::geometry) AS pickup_lng,
  o.dropoff_address, ST_Y(o.dropoff_location::geometry) AS dropoff_lat, ST_X(o.dropoff_location::geometry) AS dropoff_lng,
  o.item, o.package_size, o.distance_meters, o.price_kobo::int AS price_kobo, o.driver_id, o.pickup_photo_id,
  o.cancel_reason, o.paid_at, o.needs_attention, o.created_at, o.updated_at`;

export class OrdersService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  async create(raw: unknown): Promise<{ order: any; trackingToken: string }> {
    const input = CreateOrderInput.parse(raw);
    const { priceKobo, distanceMeters } = quoteKobo(input.pickup.location, input.dropoff.location, input.packageSize);
    const id = uuidv7();
    const trackingToken = newTrackingToken();
    const pinSalt = randomBytes(8).toString('hex');
    const pin = pinFromToken(this.config.pinSecret, trackingToken);

    await withTx(this.db, async (tx) => {
      await tx.query(
        `INSERT INTO orders (id, status, customer_name, customer_phone, customer_email, receiver_name,
           pickup_address, pickup_location, dropoff_address, dropoff_location, item, package_size,
           distance_meters, price_kobo, tracking_token_hash, pin_hash, pin_salt)
         VALUES ($1, 'AWAITING_PAYMENT', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          id,
          input.customer.name,
          input.customer.phone,
          input.customer.email,
          input.receiverName,
          input.pickup.address,
          point(input.pickup.location.lat, input.pickup.location.lng),
          input.dropoff.address,
          point(input.dropoff.location.lat, input.dropoff.location.lng),
          input.item,
          input.packageSize,
          distanceMeters,
          priceKobo,
          sha256(trackingToken),
          hashPin(pinSalt, pin),
          pinSalt,
        ],
      );
      await recordCreated(tx, id);
    });
    return { order: await this.getById(id), trackingToken };
  }

  async getById(id: string): Promise<any> {
    const res = await this.db.query(`SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.id = $1`, [id]);
    if (!res.rowCount) throw notFound('order not found');
    return res.rows[0];
  }

  /** What the customer and receiver see. Driver position only during the delivery leg (ADR-0003). */
  async getForTracking(trackingToken: string): Promise<any> {
    const res = await this.db.query(
      `SELECT ${ORDER_COLUMNS}, u.name AS driver_name, d.vehicle AS driver_vehicle,
              ST_Y(d.last_location::geometry) AS driver_lat, ST_X(d.last_location::geometry) AS driver_lng, d.last_seen_at AS driver_seen_at
         FROM orders o LEFT JOIN drivers d ON d.user_id = o.driver_id LEFT JOIN users u ON u.id = d.user_id
        WHERE o.tracking_token_hash = $1`,
      [sha256(trackingToken)],
    );
    if (!res.rowCount) throw notFound('tracking link not found');
    const o = res.rows[0];
    const live = LIVE_LOCATION_STATUSES.includes(o.status);
    const events = await this.timeline(o.id);
    const payment = (
      await this.db.query(`SELECT status, checkout_url FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [o.id])
    ).rows[0];
    return {
      id: o.id,
      status: o.status,
      version: o.version,
      receiverName: o.receiver_name,
      pickupAddress: o.pickup_address,
      dropoffAddress: o.dropoff_address,
      dropoff: { lat: o.dropoff_lat, lng: o.dropoff_lng },
      item: o.item,
      packageSize: o.package_size,
      distanceMeters: o.distance_meters,
      priceKobo: o.price_kobo,
      cancelReason: o.cancel_reason,
      hasPickupPhoto: Boolean(o.pickup_photo_id),
      pin: o.status === 'AWAITING_PAYMENT' || o.status === 'EXPIRED' ? null : pinFromToken(this.config.pinSecret, trackingToken),
      driver: o.driver_id ? { name: firstNameAndInitial(o.driver_name), vehicle: o.driver_vehicle } : null,
      driverLocation: live && o.driver_lat != null ? { lat: o.driver_lat, lng: o.driver_lng, at: o.driver_seen_at } : null,
      payment: payment ? { status: payment.status, checkoutUrl: o.status === 'AWAITING_PAYMENT' ? payment.checkout_url : null } : null,
      timeline: events.map((e) => ({ type: e.type, to: e.to_status, at: e.occurred_at, recordedAt: e.recorded_at })),
    };
  }

  async timeline(orderId: string): Promise<any[]> {
    return (
      await this.db.query(
        `SELECT seq, type, from_status, to_status, actor, payload, occurred_at, recorded_at FROM order_events WHERE order_id = $1 ORDER BY seq`,
        [orderId],
      )
    ).rows;
  }

  /** The dispatcher's queue: everything not yet finished, plus recent finished orders. */
  async listForDispatch(): Promise<any[]> {
    const res = await this.db.query(
      `SELECT ${ORDER_COLUMNS}, u.name AS driver_name,
              (SELECT json_build_object('driverId', f.driver_id, 'expiresAt', f.expires_at, 'driverName', fu.name)
                 FROM offers f JOIN users fu ON fu.id = f.driver_id WHERE f.order_id = o.id AND f.status = 'pending') AS pending_offer
         FROM orders o LEFT JOIN users u ON u.id = o.driver_id
        WHERE o.status NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED', 'EXPIRED') OR o.updated_at > now() - interval '6 hours'
        ORDER BY o.created_at DESC LIMIT 200`,
    );
    return res.rows;
  }

  async detailForDispatch(id: string): Promise<any> {
    const order = await this.getById(id);
    const [events, offers, payments, refunds] = await Promise.all([
      this.timeline(id),
      this.db.query(
        `SELECT f.id, f.driver_id, u.name AS driver_name, f.status, f.expires_at, f.created_at, f.decided_at
           FROM offers f JOIN users u ON u.id = f.driver_id WHERE f.order_id = $1 ORDER BY f.created_at`,
        [id],
      ),
      this.db.query(
        `SELECT id, provider, provider_reference, amount_kobo::int AS amount_kobo, status, role, created_at FROM payments WHERE order_id = $1 ORDER BY created_at`,
        [id],
      ),
      this.db.query(
        `SELECT r.id, r.payment_id, r.amount_kobo::int AS amount_kobo, r.reason, r.status, r.created_at FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.order_id = $1`,
        [id],
      ),
    ]);
    return { order, events, offers: offers.rows, payments: payments.rows, refunds: refunds.rows };
  }

  async cancel(orderId: string, actor: Actor, actorId: string | undefined, reason: string, commandId?: string): Promise<any> {
    await withTx(this.db, (tx) => cancelInTx(tx, { orderId, actor, actorId, reason, commandId }));
    return this.getById(orderId);
  }
}

function firstNameAndInitial(name: string | null): string | null {
  if (!name) return null;
  const [first, last] = name.split(' ');
  return last ? `${first} ${last[0]}.` : first!;
}

/**
 * Cancels a paid-or-unpaid order before pickup and starts compensation (ADR-0004): withdraw offers,
 * free the driver, reverse the order liability, and ask for a refund of the payment if there was one.
 */
export async function cancelInTx(
  tx: Tx,
  input: { orderId: string; actor: Actor; actorId?: string; reason: string; commandId?: string },
): Promise<OrderRow> {
  const { order, replayed, from } = await applyOrderEvent(tx, {
    orderId: input.orderId,
    event: 'cancelled',
    actor: input.actor,
    actorId: input.actorId,
    commandId: input.commandId,
    payload: { reason: input.reason },
    patch: { cancel_reason: input.reason },
  });
  if (replayed) return order;

  await tx.query(`UPDATE offers SET status = 'withdrawn', decided_at = now() WHERE order_id = $1 AND status = 'pending'`, [order.id]);
  if (order.driver_id && ['ASSIGNED', 'EN_ROUTE_TO_PICKUP'].includes(from)) await releaseDriver(tx, order.driver_id);

  if (isPaidPrePickup(from as OrderStatus)) {
    const pay = await tx.query(`SELECT id, amount_kobo::int AS amount FROM payments WHERE order_id = $1 AND role = 'primary' FOR UPDATE`, [order.id]);
    if (pay.rowCount) {
      const p = pay.rows[0];
      await post(
        tx,
        [
          { account: 'order_liability', amountKobo: p.amount },
          { account: 'refunds_payable', amountKobo: -p.amount },
        ],
        { memo: `cancelled before pickup: ${input.reason}`, orderId: order.id, paymentId: p.id },
      );
      await enqueue(tx, { type: 'payment.refund_required', payload: { paymentId: p.id, reason: `order cancelled: ${input.reason}` } }, { aggregateId: order.id });
    }
  }
  return order;
}

export async function releaseDriver(tx: Tx, driverId: string): Promise<void> {
  await tx.query(`UPDATE drivers SET status = 'available', idle_since = now() WHERE user_id = $1 AND status = 'busy'`, [driverId]);
  await enqueue(tx, { type: 'driver.status_changed', payload: { driverId, status: 'available' } }, { aggregateId: driverId });
}
