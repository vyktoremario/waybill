import { custom, defineConfig, eventsTakeEffect, finalState } from 'hookstorm-cli';

/**
 * F4: Hookstorm plays Paystack against the real webhook endpoint, with duplicates, concurrent duplicates,
 * reordering (refund before charge), dropped responses and timeouts, then checks these rules.
 *
 *   pnpm --filter @waybill/api hookstorm:serve     # api on :4200 with its own database and the test routes
 *   pnpm --filter @waybill/api hookstorm           # realistic profile, 20 seeds
 *   pnpm --filter @waybill/api hookstorm -- --profile hostile --runs 30
 */
type Data = { reference?: string; transaction_reference?: string; amount: number };
const refOf = (json: unknown) => {
  const d = (json as { data: Data }).data;
  return d.reference ?? d.transaction_reference;
};

export default defineConfig({
  target: 'http://127.0.0.1:4200/webhooks/paystack',
  provider: 'paystack',
  secret: 'sk_test_waybill_local', // test-mode key the api verifies signatures with
  events: './hookstorm/events.jsonl',
  profile: 'realistic',
  reset: '/hookstorm/reset',
  probe: '/hookstorm/state',
  eventKey: (e) => refOf(e.json),

  invariants: [
    eventsTakeEffect({
      forEachEvent: ['charge.success', 'refund.processed'],
      eventKey: (e) => refOf(e.json),
      record: (state: any, ref) => state.payments[ref!],
      description: 'every acknowledged charge or refund changes its payment',
    }),

    custom('an order is paid by at most one payment', ({ state }: any) => {
      const primaries = new Map<string, number>();
      for (const p of Object.values<any>(state.payments)) if (p.role === 'primary') primaries.set(p.order_id, (primaries.get(p.order_id) ?? 0) + 1);
      return [...primaries].filter(([, n]) => n > 1).map(([id, n]) => ({ key: id, message: `order ${id} has ${n} primary payments` }));
    }),

    custom('each charge is booked in the ledger at most once', ({ state }: any) => {
      const seen = new Map<string, number>();
      for (const l of state.ledger) if (l.account === 'provider_clearing' && l.amount > 0) seen.set(l.reference, (seen.get(l.reference) ?? 0) + 1);
      return [...seen].filter(([, n]) => n > 1).map(([ref, n]) => ({ key: ref, message: `${ref} booked ${n} times` }));
    }),

    custom('ledger groups balance', ({ state }: any) => (state.unbalancedGroups ? [`${state.unbalancedGroups} unbalanced ledger groups`] : [])),

    finalState('a refunded payment stays refunded', (state: any, obs) =>
      obs.events
        .filter((e) => e.type === 'refund.processed' && obs.isAcked(e.id))
        .map((e) => refOf(e.json)!)
        .filter((ref) => state.payments[ref]?.status !== 'refunded')
        .map((ref) => `${ref} ended as "${state.payments[ref]?.status}" after its refund was acknowledged`),
    ),

    finalState('an order whose payment was refunded does not go ahead', (state: any) =>
      Object.values<any>(state.payments)
        .filter((p) => p.role === 'primary' && p.status === 'refunded' && !['CANCELLED'].includes(p.order_status))
        .map((p) => `order ${p.order_id} is ${p.order_status} although its payment ${p.reference} was refunded`),
    ),

    finalState('a second payment for an order is refunded or queued for refund', (state: any) =>
      Object.values<any>(state.payments)
        .filter((p) => p.role === 'extra' && p.status === 'succeeded' && !p.refund_queued)
        .map((p) => `${p.reference} is an extra payment but no refund was started`),
    ),
  ],
});
