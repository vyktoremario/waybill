# Waybill: spec

Status: **draft, awaiting sign-off**

## 1. Goal

A dispatcher-assisted, same-day delivery platform for Nigerian cities. A customer books and pays for a delivery, a dispatcher sees every order and driver on a live map, and drivers run each job from a mobile app that keeps working on bad networks.

The core (orders, assignment, state, money ledger) is transactional and idempotent. Payment providers and drivers' phones are treated as asynchronous, unreliable inputs to that core, never as the thing that drives it. The main proof is a reproducible failure demo: kill services mid-delivery and show no lost orders and no double charges.

Payments use Paystack (test mode) only. There is no crypto.

## 2. Actors

| Actor | Surface | Can do |
| --- | --- | --- |
| **Customer** (sender) | Web: create order + Paystack checkout; tracking page | Create an order, pay, cancel before pickup, track, share the tracking link with the receiver |
| **Receiver** | Tracking page only (no account) | Watch the driver after pickup; read out the delivery PIN |
| **Dispatcher** | Web dashboard (Next.js) | See the order queue and live map, assign/reassign drivers (system suggests), cancel, trigger refunds, see failures (stuck orders, dead letters) |
| **Driver** | Expo React Native app | Go online/offline, accept/decline offers, step through pickup → drop-off, works offline |
| **System** | Worker process | Outbox relay, offer timeouts, payment reconciliation, compensations |

Auth is kept small: seeded dispatcher and driver accounts with email + password (JWT). Customers check out as guests with phone + email and get a signed tracking link. There are no customer accounts in this version.

## 3. Core flow (happy path)

1. Customer enters pickup, drop-off, item and package size → gets a quote (flat base + per-km over straight-line distance, in kobo) → order `AWAITING_PAYMENT`.
2. Paystack checkout (test mode). The webhook `charge.success` is verified and recorded → order `PAID` → event `order.paid`.
3. The assignment worker ranks nearby online drivers whose vehicle fits the package size and offers the job to the best one (30 s TTL). The dispatcher can override at any time.
4. Driver accepts → `ASSIGNED` → `EN_ROUTE_TO_PICKUP` → takes a pickup photo → `PICKED_UP` → `EN_ROUTE_TO_DROPOFF` → enters the receiver's delivery PIN → `DELIVERED`.
5. A ledger entry credits the driver's earnings. Payouts themselves are out of scope.
6. The tracking page shows the status timeline at all times, and the driver's live position only between pickup and delivery.

## 4. Delivery state machine

```
        ┌──────────── cancel (customer/dispatcher) ──────────────────────┐
        │                                                                 ▼
AWAITING_PAYMENT ──pay──►         PAID ──offer──► OFFERED ──accept──► ASSIGNED
                 │                 ▲  ◄─decline/timeout─┘                 │
          expire │                 └──────── unassign (dispatcher) ◄──────┤
                 ▼                                                        ▼
             EXPIRED                                            EN_ROUTE_TO_PICKUP
                                                                          │ pickup photo
                                                                          ▼
                       CANCELLED ◄── cancel before pickup ──        PICKED_UP
                           │                                              │
                           ▼                                              ▼
                    (refund saga)                                 EN_ROUTE_TO_DROPOFF
                                                                   │             │ delivery PIN
                                                    failed attempt ▼             ▼
                                                        RETURNING → RETURNED   DELIVERED
```

Rules (details in ADR-0002):
- Transitions are defined once, in `packages/shared` as a typed table `(from, event, to, allowedActors, guards)`. API, worker and driver app all import it, and the app uses it to render the next allowed actions.
- Every transition is one DB transaction: `UPDATE orders SET status=$to, version=version+1 WHERE id=$id AND version=$expected` plus an insert into `order_events` plus an insert into `outbox`. If 0 rows are updated, the request is a conflict and is never silently overwritten.
- Each transition request carries a client-generated `commandId` (UUID). `order_events.command_id` is UNIQUE, so a replayed command returns the original result.
- Payment and refund state is a separate state machine (ADR-0004). An order is never "un-paid".

## 5. Data model (Postgres 16 + PostGIS)

Money is `bigint` kobo everywhere. Times are `timestamptz`. IDs are UUIDv7 (time-ordered).

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | id, role (`dispatcher`/`driver`), email, password_hash | Customers are not users in this version |
| `drivers` | user_id, status (`offline`/`available`/`busy`), vehicle (`bike`/`car`/`van`), last_seen_at | Vehicle decides which package sizes a driver can take |
| `orders` | id, status, version, customer_name/phone/email, pickup/dropoff (geography Point + address text), item, package_size, price_kobo, driver_id, tracking_token_hash, delivery_pin_hash, pickup_photo_url, created_at… | The PIN is stored only as a hash |
| `order_events` | id, order_id, seq, type, from_status, to_status, actor, command_id UNIQUE, payload jsonb, occurred_at, recorded_at | Append-only audit trail; the timeline UI reads from it |
| `offers` | id, order_id, driver_id, status (`pending`/`accepted`/`declined`/`expired`), expires_at | Partial unique index: at most one `pending` offer per order |
| `payments` | id, order_id, provider, provider_reference UNIQUE, amount_kobo, status (`initiated`/`pending`/`succeeded`/`failed`/`refund_pending`/`refunded`), idempotency_key UNIQUE | One order can have several attempts. At most one `succeeded` per order (partial unique index); any extra is auto-refunded |
| `refunds` | id, payment_id, amount_kobo, reason, status, provider_refund_id, idempotency_key UNIQUE | |
| `inbox` | provider, event_id, received_at, processed_at, payload | `UNIQUE(provider, event_id)` dedupes webhooks |
| `outbox` | id, aggregate_id, type, payload, created_at, published_at, attempts | Written in the same transaction as the state change |
| `processed_messages` | consumer, message_id | Makes consumers idempotent |
| `ledger_entries` | id, account (`customer`, `platform`, `driver:<id>`, `provider_clearing`), order_id, amount_kobo (±), entry_group | Double-entry: each group sums to 0. The invariant checker relies on this |
| `location_points` | driver_id, order_id, recorded_at, lat/lng, accuracy, seq, received_at | Breadcrumb history, written in batches; the latest point lives in Redis |

## 6. Architecture (summary; diagram goes in the README)

Everything deploys on Vercel (ADR-0001). Managed services come from the Vercel Marketplace where possible.

```
Expo driver app ── HTTPS: commands + location batches ──────────┐
Next.js web app: dispatcher dashboard, tracking page, checkout  │
   └── WebSocket (downlink: live positions, status) ──┐         │
                                                      ▼         ▼
            realtime (Vercel Function, WebSocket)    api (NestJS on Vercel Functions)
                  ▲ Redis pub/sub                     │ tx: state + outbox; latest location
                  │                                   ▼
            Redis (Upstash) ◄──────────────── Postgres + PostGIS (Neon)
                  ▲                                   ▲ outbox relay
                  │ publish status/positions          │
            worker (Vercel Daemon, Docker) ◄──► RabbitMQ (CloudAMQP: topic exchange, retry + DLQ)
                  │ assignment, offer timeouts, reconciliation, refunds
                  ▼
            Paystack (test mode) ── webhooks ──► api /webhooks/paystack
```

The backend is a **modular monolith**: one NestJS codebase with an `api` entrypoint (Vercel Functions) and a `worker` entrypoint (a Vercel Daemon). Locally, docker compose runs the same two processes plus Postgres, RabbitMQ and Redis. That gives the failure demo separate processes to kill, without the overhead of microservices.

## 7. Behaviour on bad networks (driver app)

Summary of ADR-0006:
- Every driver action becomes a **command** in a local SQLite queue `{commandId, orderId, type, expectedVersion, payload, createdAt}`, applied optimistically to the UI, and sent in order with retry and backoff. The server dedupes by `commandId`.
- The delivery PIN can be checked **offline**: the device gets a salted hash with the assignment, verifies locally, and the server re-verifies on sync. Pickup photos queue for upload.
- Location points are buffered with device timestamps and sequence numbers and sent in batches over HTTPS, both online and after reconnecting. The server stores late points as history and does not broadcast them as "live".
- Conflicts (e.g. the dispatcher cancelled while the driver was offline): the server rejects the command with the current state, and the app shows a clear "this order changed" screen. The app never silently forks.
- The UI always shows connection state: Online / Offline · N actions waiting / Syncing.

## 8. Failure demo (the main proof)

`make demo-failures` (docker compose, locally) runs scripted scenarios against the real stack, then runs an **invariant checker** (SQL + API) that must pass:

**Invariants**
1. No lost orders: every order that reached `AWAITING_PAYMENT` ends in a valid state, and its `order_events` chain is complete (seq has no gaps).
2. No double charges: for each order, succeeded payments − refunded payments ≤ 1, and every extra success has a completed refund.
3. A paid order is either assigned/delivered, or cancelled with a refund. None is stuck in `PAID` beyond the assignment SLA without an alert.
4. Every ledger entry group sums to 0. Driver earnings = sum of fees from delivered orders.
5. Every outbox row is eventually published. Each consumer processes each message at most once (`processed_messages`).

**Scenarios**
| # | Fault | Expected outcome |
| --- | --- | --- |
| F1 | `kill -9 worker` right after a webhook commits `PAID`, before the outbox relays | On restart the relay publishes `order.paid`; assignment proceeds; one payment |
| F2 | `kill -9 api` while a webhook is in flight (after the inbox insert, before commit) | Transaction rolls back; Paystack/Hookstorm retries; processed exactly once |
| F3 | Stop RabbitMQ for 60 s during several deliveries | Outbox backs up (visible on the dashboard), drains on restart; no events lost |
| F4 | Hookstorm `hostile` profile on `/webhooks/paystack`: duplicates, concurrent duplicates, refund before charge, dropped responses, timeouts | Hookstorm invariants hold across N seeds; numbers go in the README |
| F5 | Payment succeeds, but no driver accepts within the SLA (or every driver declines) | Compensation: order `CANCELLED`, refund issued once, customer notified |
| F6 | Customer pays twice (two checkout tabs) | The second success is refunded automatically; ledger balanced |
| F7 | Webhook never arrives (dropped entirely) | Reconciler polls Paystack `verify` for stale `pending` payments and completes the order |
| F8 | Driver offline for 2 min mid-delivery; does pickup offline; reconnects | Commands replay once; timeline shows device time and received time; no duplicate transitions |
| F9 | Dispatcher cancels while the driver is offline and the driver then marks picked up | Server rejects with the current state; app shows the conflict screen; no ghost pickup |

The demo uses a **local Paystack simulator** (same HMAC-SHA512 signature, same `verify`/`refund` endpoints), so it runs offline and gives the same result every time. A separate `make demo-paystack` path uses real Paystack test mode through a tunnel. On the deployed stack, F1 can be shown by restarting the Daemon from the Vercel dashboard.

## 9. Scope: ~8–10 part-time weeks (~10–12 h/week)

| Week | Deliverable |
| --- | --- |
| 1 | Monorepo (pnpm + Turborepo), docker compose (pg/PostGIS, RabbitMQ, Redis), shared state machine + tests, DB schema/migrations. **Hosting spike:** NestJS on Vercel Functions, a WebSocket function, and a Daemon connecting to CloudAMQP (ADR-0001 risks) |
| 2 | Orders API, transitions with optimistic locking and command idempotency, `order_events`, outbox + relay, RabbitMQ topology (retry/DLQ) |
| 3 | Payments: Paystack adapter + simulator, webhook inbox, reconciler, refunds, ledger; Hookstorm run (F4) |
| 4 | Assignment: driver availability, PostGIS ranking, offers with TTL, dispatcher override, compensation saga (F5, F6) |
| 5 | Realtime: location ingest, Redis fan-out, WebSocket function with rooms and authz, breadcrumbs |
| 6 | Next.js: dispatcher dashboard (queue + live map) and tracking page; customer checkout page |
| 7 | Expo driver app: auth, online toggle, offer, active delivery flow, PIN and photo, location |
| 8 | Driver offline queue + conflict handling (F8, F9); failure-demo scripts + invariant checker (F1–F3, F7) |
| 9 | Deploys, README with architecture diagram, recorded demo |
| 10 | Buffer: hardening, write-up |

**Out of scope:** driver payouts, chat, reviews, referrals, customer accounts, multi-stop routes, a real routing/ETA engine (straight-line ETA, labelled as an estimate), push notifications (in-app only), multi-city/tenancy, any crypto payment.

## 10. Stack and hosting

- **Monorepo:** pnpm workspaces + Turborepo. `apps/api` (NestJS 11: REST + webhooks, plus the `worker` entrypoint and a small realtime WebSocket function), `apps/web` (Next.js 15, App Router), `apps/driver` (Expo SDK, expo-router, expo-sqlite, expo-location), `packages/shared` (zod schemas, state machine, event contracts).
- **DB access:** `pg` with plain SQL and numbered SQL migrations. Every transaction boundary and row lock is visible in the code (no ORM `save()` hiding read-then-write races).
- **Maps:** MapLibre GL (web) and react-native-maps (driver) on OpenStreetMap-based tiles, so no API key is needed for the demo.
- **Tests:** Vitest unit tests (state machine, payment state, ledger), Testcontainers integration tests (Postgres, RabbitMQ, Redis), Hookstorm in CI for webhooks, Playwright smoke test for the tracking page.
- **Hosting (all Vercel, see ADR-0001):** web and `api` on Vercel Functions; realtime on a Vercel Function using WebSockets (public beta); `worker` as a Vercel Daemon (public beta, Dockerfile). Postgres on Neon (supports PostGIS), Redis on Upstash, RabbitMQ on CloudAMQP. Driver app via an Expo dev build / EAS preview, not the app stores.

## 11. Decisions taken

- **Name:** Waybill.
- **Vercel plan: Hobby.** The deployed worker Daemon (1 GiB) gets about 17 days of runtime a month, so it runs when the deployed demo is being shown and is stopped otherwise. WebSocket clients reconnect every 300 s, which the realtime design treats as routine. The full failure demo always runs locally with docker compose.
