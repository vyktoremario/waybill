export type Tone = 'neutral' | 'info' | 'active' | 'done' | 'attention' | 'problem';

export const STATUS_LABEL: Record<string, { customer: string; dispatch: string; tone: Tone }> = {
  AWAITING_PAYMENT: { customer: 'Waiting for payment', dispatch: 'Awaiting payment', tone: 'neutral' },
  PAID: { customer: 'Finding a driver', dispatch: 'Needs driver', tone: 'info' },
  OFFERED: { customer: 'Finding a driver', dispatch: 'Offered', tone: 'info' },
  ASSIGNED: { customer: 'Driver assigned', dispatch: 'Assigned', tone: 'active' },
  EN_ROUTE_TO_PICKUP: { customer: 'Driver heading to pickup', dispatch: 'To pickup', tone: 'active' },
  PICKED_UP: { customer: 'Picked up', dispatch: 'Picked up', tone: 'active' },
  EN_ROUTE_TO_DROPOFF: { customer: 'On the way to you', dispatch: 'To drop-off', tone: 'active' },
  DELIVERED: { customer: 'Delivered', dispatch: 'Delivered', tone: 'done' },
  RETURNING: { customer: 'Returning to sender', dispatch: 'Returning', tone: 'attention' },
  RETURNED: { customer: 'Returned to sender', dispatch: 'Returned', tone: 'attention' },
  CANCELLED: { customer: 'Cancelled', dispatch: 'Cancelled', tone: 'problem' },
  EXPIRED: { customer: 'Expired (not paid)', dispatch: 'Expired', tone: 'neutral' },
};

export const EVENT_LABEL: Record<string, string> = {
  created: 'Order created',
  payment_succeeded: 'Paid',
  payment_expired: 'Payment window closed',
  offer_sent: 'Offered to a driver',
  offer_declined: 'Driver declined',
  offer_expired: 'Offer expired',
  offer_accepted: 'Driver accepted',
  dispatcher_assigned: 'Assigned by dispatch',
  unassigned: 'Unassigned by dispatch',
  trip_started: 'Driver heading to pickup',
  pickup_confirmed: 'Picked up',
  dropoff_started: 'On the way to drop-off',
  delivery_confirmed: 'Delivered',
  delivery_failed: 'Delivery attempt failed',
  return_confirmed: 'Returned to sender',
  cancelled: 'Cancelled',
};

export function fmtTime(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function naira(kobo: number): string {
  return `₦${Math.round(kobo / 100).toLocaleString('en-NG')}`;
}

export function shortRef(id: string): string {
  // A readable waybill number from the order id (UUIDv7 tail).
  const t = id.replace(/-/g, '').slice(-8).toUpperCase();
  return `WB-${t.slice(0, 4)}-${t.slice(4)}`;
}
