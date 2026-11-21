import { transition, type Actor, type OrderEvent, type OrderStatus } from '@waybill/shared';
import type { Tx } from '../db/db';
import { conflict, forbidden, notFound } from '../errors';
import { enqueue } from '../outbox/outbox';

export interface OrderRow {
  id: string;
  status: OrderStatus;
  version: number;
  driver_id: string | null;
  price_kobo: string; // bigint comes back as a string
  paid_at: Date | null;
  [k: string]: unknown;
}

export interface ApplyInput {
  orderId: string;
  event: OrderEvent;
  actor: Actor;
  actorId?: string;
  /** Client-generated id; a replay returns the stored result instead of applying twice. */
  commandId?: string;
  /** Optimistic concurrency check from clients that hold a version (the driver app). */
  expectedVersion?: number;
  occurredAt?: Date;
  payload?: Record<string, unknown>;
  /** Extra columns to set on the order in the same UPDATE (e.g. driver_id). */
  patch?: Record<string, unknown>;
}

export interface ApplyResult {
  order: OrderRow;
  replayed: boolean;
  from: OrderStatus;
}

const PATCHABLE = new Set(['driver_id', 'pickup_photo_id', 'cancel_reason', 'paid_at', 'needs_attention']);

/**
 * The only way an order changes status (ADR-0002): lock the row, check the transition table and the
 * expected version, update, append to order_events, and enqueue order.status_changed, all in the caller's
 * transaction.
 */
export async function applyOrderEvent(tx: Tx, input: ApplyInput): Promise<ApplyResult> {
  if (input.commandId) {
    const prior = await tx.query(`SELECT order_id, from_status FROM order_events WHERE command_id = $1`, [input.commandId]);
    if (prior.rowCount) {
      if (prior.rows[0].order_id !== input.orderId) throw conflict('commandId was already used for another order');
      const order = (await tx.query(`SELECT * FROM orders WHERE id = $1`, [input.orderId])).rows[0];
      return { order, replayed: true, from: prior.rows[0].from_status };
    }
  }

  const res = await tx.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [input.orderId]);
  if (!res.rowCount) throw notFound('order not found');
  const order: OrderRow = res.rows[0];

  if (input.expectedVersion !== undefined && input.expectedVersion !== order.version) {
    throw conflict('order changed since you last saw it', { status: order.status, version: order.version });
  }
  const t = transition(order.status, input.event, input.actor);
  if (!t.ok) {
    if (t.reason === 'actor_not_allowed') throw forbidden(`${input.actor} cannot ${input.event} from ${order.status}`);
    throw conflict(`cannot ${input.event} from ${order.status}`, { status: order.status, version: order.version });
  }

  const sets = ['status = $2', 'version = version + 1', 'updated_at = now()'];
  const params: unknown[] = [order.id, t.to];
  for (const [col, val] of Object.entries(input.patch ?? {})) {
    if (!PATCHABLE.has(col)) throw new Error(`column ${col} is not patchable`);
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  const updated: OrderRow = (await tx.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params)).rows[0];

  await tx.query(
    `INSERT INTO order_events (order_id, seq, type, from_status, to_status, actor, actor_id, command_id, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      order.id,
      updated.version,
      input.event,
      order.status,
      t.to,
      input.actor,
      input.actorId ?? null,
      input.commandId ?? null,
      JSON.stringify(input.payload ?? {}),
      input.occurredAt ?? new Date(),
    ],
  );
  await enqueue(
    tx,
    { type: 'order.status_changed', payload: { orderId: order.id, from: order.status, to: t.to, version: updated.version, event: input.event } },
    { aggregateId: order.id },
  );
  return { order: updated, replayed: false, from: order.status };
}

/** The first event of an order (creation), which has no "from" status. */
export async function recordCreated(tx: Tx, orderId: string): Promise<void> {
  await tx.query(
    `INSERT INTO order_events (order_id, seq, type, from_status, to_status, actor) VALUES ($1, 0, 'created', NULL, 'AWAITING_PAYMENT', 'customer')`,
    [orderId],
  );
  await enqueue(
    tx,
    { type: 'order.status_changed', payload: { orderId, from: null, to: 'AWAITING_PAYMENT', version: 0, event: 'created' } },
    { aggregateId: orderId },
  );
}
