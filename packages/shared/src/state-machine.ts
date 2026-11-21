/**
 * The delivery state machine (ADR-0002). This table is the only definition of which
 * transitions exist: the API enforces it, the worker uses it, and the driver app renders
 * its buttons from it.
 */

export const ORDER_STATUSES = [
  'AWAITING_PAYMENT',
  'PAID',
  'OFFERED',
  'ASSIGNED',
  'EN_ROUTE_TO_PICKUP',
  'PICKED_UP',
  'EN_ROUTE_TO_DROPOFF',
  'DELIVERED',
  'RETURNING',
  'RETURNED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ACTORS = ['customer', 'dispatcher', 'driver', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

export const ORDER_EVENTS = [
  'payment_succeeded',
  'payment_expired',
  'offer_sent',
  'offer_declined',
  'offer_expired',
  'offer_accepted',
  'dispatcher_assigned',
  'unassigned',
  'trip_started',
  'pickup_confirmed',
  'dropoff_started',
  'delivery_confirmed',
  'delivery_failed',
  'return_confirmed',
  'cancelled',
] as const;
export type OrderEvent = (typeof ORDER_EVENTS)[number];

export interface Transition {
  from: readonly OrderStatus[];
  event: OrderEvent;
  to: OrderStatus;
  actors: readonly Actor[];
}

const PRE_PICKUP: readonly OrderStatus[] = ['PAID', 'OFFERED', 'ASSIGNED', 'EN_ROUTE_TO_PICKUP'];

export const TRANSITIONS: readonly Transition[] = [
  { from: ['AWAITING_PAYMENT'], event: 'payment_succeeded', to: 'PAID', actors: ['system'] },
  { from: ['AWAITING_PAYMENT'], event: 'payment_expired', to: 'EXPIRED', actors: ['system'] },
  { from: ['PAID'], event: 'offer_sent', to: 'OFFERED', actors: ['system'] },
  { from: ['OFFERED'], event: 'offer_declined', to: 'PAID', actors: ['driver'] },
  { from: ['OFFERED'], event: 'offer_expired', to: 'PAID', actors: ['system'] },
  { from: ['OFFERED'], event: 'offer_accepted', to: 'ASSIGNED', actors: ['driver'] },
  { from: ['PAID', 'OFFERED'], event: 'dispatcher_assigned', to: 'ASSIGNED', actors: ['dispatcher'] },
  { from: ['ASSIGNED', 'EN_ROUTE_TO_PICKUP'], event: 'unassigned', to: 'PAID', actors: ['dispatcher'] },
  { from: ['ASSIGNED'], event: 'trip_started', to: 'EN_ROUTE_TO_PICKUP', actors: ['driver'] },
  { from: ['ASSIGNED', 'EN_ROUTE_TO_PICKUP'], event: 'pickup_confirmed', to: 'PICKED_UP', actors: ['driver'] },
  { from: ['PICKED_UP'], event: 'dropoff_started', to: 'EN_ROUTE_TO_DROPOFF', actors: ['driver'] },
  { from: ['EN_ROUTE_TO_DROPOFF'], event: 'delivery_confirmed', to: 'DELIVERED', actors: ['driver', 'dispatcher'] },
  { from: ['EN_ROUTE_TO_DROPOFF'], event: 'delivery_failed', to: 'RETURNING', actors: ['driver', 'dispatcher'] },
  { from: ['RETURNING'], event: 'return_confirmed', to: 'RETURNED', actors: ['driver', 'dispatcher'] },
  // Customers can cancel only before a driver is on the way; dispatch and the system until pickup.
  { from: ['AWAITING_PAYMENT', 'PAID', 'OFFERED'], event: 'cancelled', to: 'CANCELLED', actors: ['customer'] },
  { from: ['AWAITING_PAYMENT', ...PRE_PICKUP], event: 'cancelled', to: 'CANCELLED', actors: ['dispatcher', 'system'] },
];

export const TERMINAL_STATUSES: readonly OrderStatus[] = ['DELIVERED', 'RETURNED', 'CANCELLED', 'EXPIRED'];

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Statuses in which the customer has paid and the order hasn't been picked up yet. */
export function isPaidPrePickup(status: OrderStatus): boolean {
  return PRE_PICKUP.includes(status);
}

/** Statuses in which a driver holds the order (tracking shows their position only in the last two). */
export const DRIVER_HOLDS: readonly OrderStatus[] = [
  'ASSIGNED',
  'EN_ROUTE_TO_PICKUP',
  'PICKED_UP',
  'EN_ROUTE_TO_DROPOFF',
  'RETURNING',
];
export const LIVE_LOCATION_STATUSES: readonly OrderStatus[] = ['PICKED_UP', 'EN_ROUTE_TO_DROPOFF'];

export type TransitionResult =
  | { ok: true; to: OrderStatus }
  | { ok: false; reason: 'not_allowed_from_status' | 'actor_not_allowed' };

export function transition(from: OrderStatus, event: OrderEvent, actor: Actor): TransitionResult {
  const candidates = TRANSITIONS.filter((t) => t.event === event && t.from.includes(from));
  if (candidates.length === 0) return { ok: false, reason: 'not_allowed_from_status' };
  const match = candidates.find((t) => t.actors.includes(actor));
  if (!match) return { ok: false, reason: 'actor_not_allowed' };
  return { ok: true, to: match.to };
}

/** Events this actor may trigger from this status, e.g. to render the next buttons. */
export function allowedEvents(from: OrderStatus, actor: Actor): OrderEvent[] {
  const out = new Set<OrderEvent>();
  for (const t of TRANSITIONS) if (t.from.includes(from) && t.actors.includes(actor)) out.add(t.event);
  return [...out];
}
