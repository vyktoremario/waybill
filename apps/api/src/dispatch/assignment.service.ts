import { VEHICLES_FOR_SIZE, type PackageSize } from '@waybill/shared';
import { uuidv7 } from 'uuidv7';
import type { Config } from '../config';
import { withTx, type Db } from '../db/db';
import { conflict, invalid, notFound } from '../errors';
import { cancelInTx, releaseDriver } from '../orders/orders.service';
import { applyOrderEvent } from '../orders/transitions';
import { enqueue } from '../outbox/outbox';

const SEARCH_RADIUS_METERS = 15_000;
const HEARTBEAT_SECONDS = 60;
const RETRY_NO_DRIVER_MS = 15_000;

/**
 * Driver assignment (ADR-0002): one pending offer per order at a time, nearest suitable driver first,
 * a TTL on every offer, and a dispatcher override that goes through the same transitions.
 */
export class AssignmentService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly log: (msg: string) => void = (m) => console.log(`[dispatch] ${m}`),
  ) {}

  /** Offers a paid order to the best available driver. Safe to call any number of times. */
  async tryAssign(orderId: string): Promise<'offered' | 'no_driver' | 'not_needed'> {
    return withTx(this.db, async (tx) => {
      const order = (await tx.query(`SELECT id, status, package_size FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
      if (!order) throw notFound('order not found');
      if (order.status !== 'PAID') return 'not_needed';

      const vehicles = VEHICLES_FOR_SIZE[order.package_size as PackageSize];
      const candidate = (
        await tx.query(
          `SELECT d.user_id
             FROM drivers d, orders o
            WHERE o.id = $1
              AND d.status = 'available'
              AND d.last_seen_at > now() - make_interval(secs => $4)
              AND d.vehicle = ANY($2)
              AND d.last_location IS NOT NULL
              AND ST_DWithin(d.last_location, o.pickup_location, $3)
              AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.order_id = o.id AND f.driver_id = d.user_id)
              AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.driver_id = d.user_id AND f.status = 'pending')
            ORDER BY d.last_location <-> o.pickup_location, d.idle_since
            LIMIT 1
            FOR UPDATE OF d SKIP LOCKED`,
          [orderId, vehicles, SEARCH_RADIUS_METERS, HEARTBEAT_SECONDS],
        )
      ).rows[0];

      if (!candidate) {
        // Keep looking until a driver frees up or the assignment SLA cancels the order.
        await enqueue(tx, { type: 'order.needs_driver', payload: { orderId } }, { aggregateId: orderId, delayMs: RETRY_NO_DRIVER_MS });
        return 'no_driver';
      }

      const offerId = uuidv7();
      const expiresAt = new Date(Date.now() + this.config.offerTtlSeconds * 1000);
      await tx.query(`INSERT INTO offers (id, order_id, driver_id, status, expires_at) VALUES ($1, $2, $3, 'pending', $4)`, [
        offerId,
        orderId,
        candidate.user_id,
        expiresAt,
      ]);
      await applyOrderEvent(tx, { orderId, event: 'offer_sent', actor: 'system', payload: { offerId, driverId: candidate.user_id } });
      await enqueue(
        tx,
        { type: 'offer.created', payload: { offerId, orderId, driverId: candidate.user_id, expiresAt: expiresAt.toISOString() } },
        { aggregateId: orderId },
      );
      await enqueue(tx, { type: 'offer.expire_check', payload: { offerId } }, { aggregateId: orderId, delayMs: this.config.offerTtlSeconds * 1000 + 500 });
      this.log(`offered ${orderId} to ${candidate.user_id}`);
      return 'offered';
    });
  }

  /** Delayed check after an offer's TTL. Early or duplicate deliveries are harmless. */
  async expireOffer(offerId: string): Promise<'expired' | 'not_pending' | 'rescheduled'> {
    return withTx(this.db, async (tx) => {
      const ref = (await tx.query(`SELECT order_id FROM offers WHERE id = $1`, [offerId])).rows[0];
      if (!ref) return 'not_pending';
      // Lock order before offer, everywhere, to avoid deadlocks with accept.
      const order = (await tx.query(`SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`, [ref.order_id])).rows[0];
      const offer = (await tx.query(`SELECT *, expires_at <= now() AS due FROM offers WHERE id = $1 FOR UPDATE`, [offerId])).rows[0];
      if (offer.status !== 'pending') return 'not_pending';
      if (!offer.due) {
        const ms = new Date(offer.expires_at).getTime() - Date.now() + 500;
        await enqueue(tx, { type: 'offer.expire_check', payload: { offerId } }, { aggregateId: order.id, delayMs: Math.max(ms, 1000) });
        return 'rescheduled';
      }
      await tx.query(`UPDATE offers SET status = 'expired', decided_at = now() WHERE id = $1`, [offerId]);
      if (order.status === 'OFFERED') {
        await applyOrderEvent(tx, { orderId: order.id, event: 'offer_expired', actor: 'system', payload: { offerId, driverId: offer.driver_id } });
        await enqueue(tx, { type: 'order.needs_driver', payload: { orderId: order.id } }, { aggregateId: order.id });
      }
      return 'expired';
    });
  }

  /**
   * Scheduled at payment + alert time and payment + SLA. Flags the order for dispatch, then runs the
   * compensation saga (cancel + refund) if nobody took it (F5).
   */
  async assignmentCheck(orderId: string): Promise<'ok' | 'flagged' | 'cancelled'> {
    return withTx(this.db, async (tx) => {
      const o = (
        await tx.query(`SELECT id, status, EXTRACT(EPOCH FROM now() - paid_at) AS age FROM orders WHERE id = $1 FOR UPDATE`, [orderId])
      ).rows[0];
      if (!o || !['PAID', 'OFFERED'].includes(o.status)) return 'ok';
      const age = Number(o.age);
      if (age >= this.config.assignmentSlaSeconds - 1) {
        await cancelInTx(tx, { orderId, actor: 'system', reason: 'no driver available' });
        this.log(`cancelled ${orderId}: no driver within SLA`);
        return 'cancelled';
      }
      if (age >= this.config.assignmentAlertSeconds - 1) {
        await tx.query(`UPDATE orders SET needs_attention = true, updated_at = now() WHERE id = $1`, [orderId]);
        return 'flagged';
      }
      return 'ok';
    });
  }

  async dispatcherAssign(orderId: string, driverId: string, dispatcherId: string, commandId?: string): Promise<void> {
    await withTx(this.db, async (tx) => {
      const order = (await tx.query(`SELECT id, status, package_size FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
      if (!order) throw notFound('order not found');
      const driver = (await tx.query(`SELECT user_id, status, vehicle FROM drivers WHERE user_id = $1 FOR UPDATE`, [driverId])).rows[0];
      if (!driver) throw notFound('driver not found');
      if (driver.status !== 'available') throw conflict(`driver is ${driver.status}`);
      if (!VEHICLES_FOR_SIZE[order.package_size as PackageSize].includes(driver.vehicle)) throw invalid(`a ${driver.vehicle} can't carry a ${order.package_size} parcel`);
      const otherOffer = await tx.query(`SELECT 1 FROM offers WHERE driver_id = $1 AND status = 'pending' AND order_id <> $2`, [driverId, orderId]);
      if (otherOffer.rowCount) throw conflict('driver has another offer open');

      const { replayed } = await applyOrderEvent(tx, {
        orderId,
        event: 'dispatcher_assigned',
        actor: 'dispatcher',
        actorId: dispatcherId,
        commandId,
        payload: { driverId },
        patch: { driver_id: driverId, needs_attention: false },
      });
      if (replayed) return;
      await tx.query(`UPDATE offers SET status = 'withdrawn', decided_at = now() WHERE order_id = $1 AND status = 'pending'`, [orderId]);
      await tx.query(`UPDATE drivers SET status = 'busy' WHERE user_id = $1`, [driverId]);
      await enqueue(tx, { type: 'driver.status_changed', payload: { driverId, status: 'busy' } }, { aggregateId: driverId });
    });
  }

  async unassign(orderId: string, dispatcherId: string, commandId?: string): Promise<void> {
    await withTx(this.db, async (tx) => {
      const order = (await tx.query(`SELECT driver_id FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
      if (!order) throw notFound('order not found');
      const { replayed } = await applyOrderEvent(tx, {
        orderId,
        event: 'unassigned',
        actor: 'dispatcher',
        actorId: dispatcherId,
        commandId,
        payload: { driverId: order.driver_id },
        patch: { driver_id: null },
      });
      if (replayed) return;
      if (order.driver_id) await releaseDriver(tx, order.driver_id);
      await enqueue(tx, { type: 'order.needs_driver', payload: { orderId } }, { aggregateId: orderId });
    });
  }

  /** A driver became available: offer them the oldest order that is waiting. */
  async onDriverAvailable(): Promise<void> {
    const waiting = await this.db.query(
      `SELECT id FROM orders o WHERE status = 'PAID'
          AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.order_id = o.id AND f.status = 'pending')
        ORDER BY paid_at LIMIT 5`,
    );
    for (const row of waiting.rows) {
      if ((await this.tryAssign(row.id)) === 'offered') return;
    }
  }
}
