import { uuidv7 } from 'uuidv7';
import type { Tx } from '../db/db';

/**
 * Event types published through the outbox (ADR-0005). Routing key = type.
 * Payloads are small; consumers re-read the current state from Postgres.
 */
export type OutboxEvent =
  | { type: 'order.status_changed'; payload: { orderId: string; from: string | null; to: string; version: number; event: string } }
  | { type: 'order.paid'; payload: { orderId: string } }
  | { type: 'order.needs_driver'; payload: { orderId: string } }
  | { type: 'order.assignment_check'; payload: { orderId: string } }
  | { type: 'offer.created'; payload: { offerId: string; orderId: string; driverId: string; expiresAt: string } }
  | { type: 'offer.expire_check'; payload: { offerId: string } }
  | { type: 'payment.refund_required'; payload: { paymentId: string; reason: string } }
  | { type: 'driver.status_changed'; payload: { driverId: string; status: string } };

export type OutboxType = OutboxEvent['type'];

/** Adds an event to the outbox inside the caller's transaction. delayMs schedules delivery (ADR-0005 delay queues). */
export async function enqueue(tx: Tx, event: OutboxEvent, opts: { aggregateId?: string; delayMs?: number } = {}): Promise<string> {
  const messageId = uuidv7();
  await tx.query(
    `INSERT INTO outbox (message_id, type, aggregate_id, payload, delay_ms) VALUES ($1, $2, $3, $4, $5)`,
    [messageId, event.type, opts.aggregateId ?? null, JSON.stringify(event.payload), Math.max(0, Math.round(opts.delayMs ?? 0))],
  );
  return messageId;
}
