import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ACTORS,
  ORDER_EVENTS,
  ORDER_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  allowedEvents,
  isTerminal,
  transition,
  type OrderStatus,
} from './state-machine';

describe('state machine', () => {
  it('runs the happy path', () => {
    const steps = [
      ['payment_succeeded', 'system', 'PAID'],
      ['offer_sent', 'system', 'OFFERED'],
      ['offer_accepted', 'driver', 'ASSIGNED'],
      ['trip_started', 'driver', 'EN_ROUTE_TO_PICKUP'],
      ['pickup_confirmed', 'driver', 'PICKED_UP'],
      ['dropoff_started', 'driver', 'EN_ROUTE_TO_DROPOFF'],
      ['delivery_confirmed', 'driver', 'DELIVERED'],
    ] as const;
    let s: OrderStatus = 'AWAITING_PAYMENT';
    for (const [event, actor, to] of steps) {
      const r = transition(s, event, actor);
      expect(r).toEqual({ ok: true, to });
      s = to;
    }
  });

  it('never leaves a terminal status', () => {
    for (const s of TERMINAL_STATUSES)
      for (const e of ORDER_EVENTS) for (const a of ACTORS) expect(transition(s, e, a).ok).toBe(false);
  });

  it('only lets the system mark an order paid', () => {
    for (const a of ACTORS.filter((x) => x !== 'system'))
      expect(transition('AWAITING_PAYMENT', 'payment_succeeded', a)).toEqual({ ok: false, reason: 'actor_not_allowed' });
  });

  it('does not allow cancelling after pickup', () => {
    for (const s of ['PICKED_UP', 'EN_ROUTE_TO_DROPOFF', 'RETURNING'] as const)
      for (const a of ACTORS) expect(transition(s, 'cancelled', a).ok).toBe(false);
  });

  it('does not let a customer cancel once a driver is assigned', () => {
    expect(transition('ASSIGNED', 'cancelled', 'customer').ok).toBe(false);
    expect(transition('ASSIGNED', 'cancelled', 'dispatcher').ok).toBe(true);
  });

  it('every status except terminal ones has a way forward', () => {
    for (const s of ORDER_STATUSES.filter((x) => !isTerminal(x)))
      expect(ACTORS.some((a) => allowedEvents(s, a).length > 0)).toBe(true);
  });

  it('every non-initial status is reachable from AWAITING_PAYMENT', () => {
    const seen = new Set<OrderStatus>(['AWAITING_PAYMENT']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of TRANSITIONS)
        if (t.from.some((f) => seen.has(f)) && !seen.has(t.to)) {
          seen.add(t.to);
          grew = true;
        }
    }
    expect([...seen].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('random event sequences only ever produce declared transitions, and money states stay consistent', () => {
    const step = fc.record({
      event: fc.constantFrom(...ORDER_EVENTS),
      actor: fc.constantFrom(...ACTORS),
    });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (seq) => {
        let s: OrderStatus = 'AWAITING_PAYMENT';
        let everPaid = false;
        for (const { event, actor } of seq) {
          const r = transition(s, event, actor);
          if (!r.ok) continue;
          const declared = TRANSITIONS.some((t) => t.event === event && t.from.includes(s) && t.to === r.to && t.actors.includes(actor));
          if (!declared) return false;
          if (r.to === 'PAID') everPaid = true;
          // Once paid, an order never goes back to awaiting payment and never "expires".
          if (everPaid && (r.to === 'AWAITING_PAYMENT' || r.to === 'EXPIRED')) return false;
          // Delivery can only happen after pickup.
          if (r.to === 'DELIVERED' && s !== 'EN_ROUTE_TO_DROPOFF') return false;
          s = r.to;
        }
        return true;
      }),
      { numRuns: 2000 },
    );
  });
});
