# ADR-0002: Delivery state machine and driver assignment

Status: proposed · Date: 2026-11-21

## Context
A common way to build this is a free-text status column, with each endpoint checking "is it not already X?" and then saving without a lock. Under concurrency that lets two drivers accept the same job, or a cancel and a pickup both succeed. Another common choice is to let drivers accept first and the customer pay afterwards, which leaves drivers travelling for orders that never get paid.

This design puts payment before assignment, so a driver never travels for an unpaid order, and makes every transition an explicit, checked, versioned operation.

## Decision

### State machine
- States: `AWAITING_PAYMENT, PAID, OFFERED, ASSIGNED, EN_ROUTE_TO_PICKUP, PICKED_UP, EN_ROUTE_TO_DROPOFF, DELIVERED, RETURNING, RETURNED, CANCELLED, EXPIRED` (diagram in SPEC §4).
- One typed transition table in `packages/shared`: `{from, event, to, actors, guard?}`. The API rejects anything not in the table. The driver app renders its buttons from the same table. Property-based tests (fast-check) generate random event sequences and check that no unreachable or terminal-escape transition is ever accepted.
- Persistence: `orders.version` for optimistic concurrency. A transition is:
  ```sql
  BEGIN;
  UPDATE orders SET status=$to, version=version+1, ... WHERE id=$id AND version=$v AND status=$from;
  -- 0 rows → 409 Conflict with the current state (never retried blindly)
  INSERT INTO order_events (..., command_id) ...;   -- UNIQUE(command_id): a replay returns the stored result
  INSERT INTO outbox (...);
  COMMIT;
  ```
- Proof of pickup and delivery: at pickup the driver takes a photo of the package (stored, shown on the timeline). At drop-off the driver enters a 4-digit delivery PIN that the receiver reads from the tracking page, the usual proof-of-delivery pattern for courier apps. Only a salted hash of the PIN is stored, and wrong attempts are rate-limited (5 per 10 minutes per order). If the receiver can't produce the PIN, the driver reports a failed attempt (`RETURNING`) or calls the dispatcher, who can override with a reason recorded in `order_events`.

### Assignment
- Triggered by the `order.paid` event (worker consumer) and by `offer.expired` / `offer.declined`.
- Candidates: drivers with `status=available`, a fresh heartbeat (< 60 s), a vehicle that fits the package size (`bike` ⊂ `car` ⊂ `van`), not yet offered this order, within R km of pickup. They are ranked by PostGIS KNN distance (`<->` on a GiST index); ties go to the driver idle longest.
- **One pending offer per order at a time** (partial unique index on `offers(order_id) WHERE status='pending'`), with a 30 s TTL. Accepting is a conditional update on the offer *and* the order in one transaction, so a double accept (or an accept racing the expiry) leaves exactly one winner.
- Offer expiry: a delayed message (RabbitMQ TTL queue → DLX, ADR-0005). The consumer re-checks `status='pending' AND expires_at <= now()`, so the message is safe to receive twice or early.
- **Dispatcher override**: assign or reassign directly. This goes through the same transition and also expires any pending offer.
- **SLA**: if the order is still `PAID`/`OFFERED` after 10 minutes, or no candidates remain, it raises a dispatcher alert. After 20 minutes the compensation saga runs: `CANCELLED` + refund (ADR-0004).
- A driver goes `busy` on accept and back to `available` on `DELIVERED`/`RETURNED`/unassign. Each driver has one active delivery at a time in this version.

## Alternatives considered
- **Broadcast to all nearby drivers, first to accept wins**: faster to fill, but it leads to accept races and lets drivers cherry-pick. The race handling above would make this safe too, so it stays a config option for later.
- **A state machine library (XState) on the server**: more than needed. A plain transition table is easier to share with React Native and to test with properties. XState may still be used in the driver UI.
- **Pessimistic locks (`SELECT … FOR UPDATE`) everywhere**: used only where needed (accepting an offer, the payment/order link). Optimistic versioning gives the driver app meaningful 409s to show on its conflict screen.

## Consequences
- Every state change is in the audit trail, and the tracking timeline reads straight from `order_events`.
- Concurrency bugs show up as 409s instead of silent overwrites. The tests deliberately run concurrent accepts and transitions.
- Pay-before-assign needs the refund saga for the "paid but nobody can take it" case. That's intended, and it is part of the failure demo (F5).
