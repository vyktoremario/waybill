# ADR-0005: Events and queues: transactional outbox + RabbitMQ

Status: proposed · Date: 2026-11-21

## Context
State changes have to trigger follow-up work: assignment after `order.paid`, refunds, socket pushes, notifications and offer timeouts. That work must happen **at least once, even if a process dies between "commit" and "publish"**, and doing it twice must be harmless. An in-process event emitter (e.g. NestJS `EventEmitter2`) loses events whenever the process dies, so it can't be used for anything that matters.

## Decision
- **Transactional outbox:** every state change inserts its events into `outbox` in the same transaction. A relay in the worker reads unpublished rows (`FOR UPDATE SKIP LOCKED`, batches of 100, ordered by id), publishes them to RabbitMQ with **publisher confirms**, then sets `published_at`. If the worker crashes after publishing but before marking the row, the message is published again, which the consumer dedupe handles. The relay wakes on Postgres `LISTEN/NOTIFY` (a trigger notifies on insert), with a 10 s safety poll, so it reacts fast without burning CPU (Vercel Daemon quotas, ADR-0001). On SIGTERM (deploys) it stops fetching, finishes the batch in flight and exits within the grace period.
- **RabbitMQ topology:**
  - `events` topic exchange, routing keys like `order.paid`, `offer.expired`, `payment.refund_required`.
  - One durable queue per consumer (`dispatch.assignment`, `payments.refunds`, `realtime.fanout`, `notify.customer`), bound by pattern.
  - Retries: on failure, nack to `<queue>.retry` (TTL 5 s → 30 s → 2 min via per-attempt queues), which dead-letters back to the main queue. After 5 attempts it goes to `<queue>.dlq`. The dispatcher dashboard shows the DLQ depth with a "replay" action.
  - Delays (offer expiry, SLA timers): publish to `delay.<n>s` queues with a TTL that dead-letter into `events`. No plugin is needed, so it runs on CloudAMQP's free tier.
- **Consumer idempotency:** each message carries `messageId = outbox.id`. Each handler runs in a transaction that starts with `INSERT INTO processed_messages(consumer, message_id) ON CONFLICT DO NOTHING`. If it's a duplicate, the handler acks and skips.
- **Ordering:** not relied on globally. Handlers check the current DB state (they react to facts, not to the message's claim), and per-order ordering is protected by `orders.version`.
- **Event contracts:** zod schemas in `packages/shared/events`, with a `v` field for versioning.

## Why RabbitMQ (vs. the alternatives)
| Option | For | Against | Verdict |
| --- | --- | --- | --- |
| **RabbitMQ** | Per-consumer queues, routing, DLX/TTL for retries and delays, publisher confirms, mature, free managed tier | One more service to run | **Chosen.** Fits work-queue semantics (each task handled once by one consumer of a group); retries and delays are built in |
| Kafka / Redpanda | Replayable log, high throughput | Heavy to operate, partitions/consumer groups are overkill at this volume, retry/delay needs extra topics | Too much for the scale |
| Redis Streams | Already running Redis | Keeping durability-critical events in a store we treat as ephemeral; manual DLQ/retry; memory-bound | Redis stays for ephemeral data (location, presence, socket adapter) |
| BullMQ | Great job API on Redis | Job queue rather than pub/sub fan-out to several consumers; same Redis durability concern | No |
| Vercel Queues | Native to the hosting platform; durable topics, at-least-once, delays, idempotency keys | Beta; dead-letter handling not documented yet; less to show about broker design | **Fallback** if a Daemon can't hold an AMQP connection (ADR-0001 spike). Only the relay and consumer adapters change |
| Postgres only (pg-boss / LISTEN/NOTIFY) | Fewest moving parts, transactional enqueue | Fine at this scale, but it doesn't show broker skills and it competes with OLTP load | A credible fallback. The outbox design means a swap only touches the relay and the consumer adapters |

Being honest about scale: at portfolio volume, Postgres-only would work. RabbitMQ is chosen because the routing, retry and DLQ behaviour is what we want to show, and the outbox keeps it from becoming a source of truth.

## Consequences
- Delivery is at least once end to end. Exactly-once *effects* come from idempotent consumers and DB constraints.
- If RabbitMQ is down, the outbox backs up (visible as a metric) and nothing is lost (F3).
- The worker is the only publisher, so `api` stays fast and unaffected by broker health.
