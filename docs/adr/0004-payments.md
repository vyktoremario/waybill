# ADR-0004: Payments: idempotent, webhook-driven, reconciled, with compensation

Status: proposed · Date: 2026-11-21

## Context
Payment confirmations are asynchronous and unreliable. Webhooks can be duplicated, reordered, delayed or never sent, and the provider can be down when we call it. Common mistakes are trusting the browser's "payment complete" callback, taking the amount from the request, storing money as a float, and doing a payment as a chain of separate writes with no idempotency. This design needs to show: **no double charges, no lost paid orders, and a correct ledger** under faults, including "payment succeeded but assignment failed".

## Decision

### Provider abstraction
`PaymentProvider { initialize(order, idempotencyKey), verify(reference), refund(reference, amount, idempotencyKey), parseWebhook(req) }`, with implementations:
- `PaystackProvider` (test mode): initialize → hosted checkout; webhook `charge.success` / `refund.processed` (HMAC-SHA512 over the raw body with the secret key); `GET /transaction/verify/:reference`; `POST /refund`.
- `PaystackSimulator`: an in-repo fake with the same API and signature, used for the offline, reproducible failure demo and for tests. Hookstorm targets the real webhook endpoint with the `paystack` preset.

### Flow
1. `POST /orders/:id/payments` with an `Idempotency-Key` header. Creates (or returns the existing) `payments` row `initiated`, with `provider_reference = payment.id`. Calls `initialize` with the same reference. A retry with the same key returns the same checkout URL.
2. **Webhook handler:** verify the signature over the raw body, then in **one transaction** `INSERT INTO inbox (provider, event_id) ON CONFLICT DO NOTHING`. If it's a duplicate, return 200. Otherwise:
   - `SELECT … FOR UPDATE` the payment by reference, and check that amount and currency match the stored values (never the payload's own claim);
   - apply the payment state machine, which is **forward-only**: `initiated → pending → succeeded → refund_pending → refunded`, plus `failed`. A late `charge.success` after `refunded` is recorded but changes nothing;
   - if this is the order's first success: order `AWAITING_PAYMENT → PAID`, ledger group (`customer -price`, `platform_clearing +price`), outbox `order.paid`;
   - if the order already has a succeeded payment, or is cancelled/expired: outbox `payment.refund_required` (the double-payment and late-payment cases).
   Then return 200. Any error rolls back and returns 500, so the provider retries. The handler does no slow work before the ack. Everything slow goes through the outbox.
3. **Reconciler** (worker, every minute): for payments `initiated/pending` older than 2 minutes, call `verify` and feed the result through the same transition code as the webhook (as a synthetic inbox event `verify:{reference}:{status}`). This covers dropped webhooks (F7). Payments `initiated` for more than 30 minutes → `failed`; the order → `EXPIRED`.
4. **Refunds** (consumer of `payment.refund_required`): insert the `refunds` row with `idempotency_key = refund:{payment_id}` (UNIQUE), call the provider with that key, mark it `refund_pending`, and complete on the `refund.processed` webhook or by reconciliation. A partial unique index means a payment can't be refunded twice.

### Compensation ("payment succeeded but assignment failed")
A small orchestrated saga in the worker, with its state on the order:
- Trigger: the assignment SLA is exceeded, no candidates are left, or the customer/dispatcher cancels before pickup.
- Steps: order `→ CANCELLED` (conditional on the status still being pre-pickup) → outbox `payment.refund_required` → refund → ledger reversal → notify the customer.
- Each step is idempotent and retried from RabbitMQ. If the driver accepts after the cancel commit, the accept fails the version check (409) and the offer is expired.
- After pickup there is no automatic refund. A failed delivery attempt goes `RETURNING → RETURNED`, and refund policy is a dispatcher decision (button → same refund path).

### Money
`bigint` kobo. A price is computed server-side once, at quote time, and stored on the order; webhooks are checked against it. Ledger entry groups must sum to 0, enforced by a deferred constraint trigger and checked by the invariant checker.

## Alternatives considered
- **Trust the client's checkout callback:** rejected. The browser can close, lie or retry; only a verified webhook or a server-side `verify` call counts.
- **Verify-only (poll, no webhooks):** simpler but slow and rate-limit-heavy. We use webhooks for speed and polling as the safety net.
- **Authorize-then-capture:** not widely available on Paystack for this use. Charge-then-refund plus the SLA is the practical equivalent.
- **Choreographed saga (services reacting to each other's events):** harder to follow for a reader. A small orchestrator keeps the compensation logic in one file.

## Consequences
- The webhook endpoint is deliberately boring, which makes it a good Hookstorm target. Invariants are written as Hookstorm rules plus the SQL checker.
- Refunds cost a fee in real life. The SLA and the dispatcher alert should keep them rare; the demo shows them working.
