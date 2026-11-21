# ADR-0001: Transactional core as a modular monolith, deployed on Vercel

Status: proposed · Date: 2026-11-21

## Context
A delivery platform depends on parties it doesn't control: the payment provider (webhooks that are late, duplicated or missing), drivers' phones (patchy mobile data) and the processes themselves (deploys, crashes). The core has to stay correct when any of them misbehaves, and the project has to show that with a demo that kills processes mid-delivery.

It is built by one person, part-time, over about 10 weeks, and hosted on Vercel, where the author already runs an API.

## Decision
- The **source of truth is Postgres**: orders, assignment, payments and the ledger. Every state change is one local ACID transaction that also writes an outbox row (ADR-0005).
- External systems (Paystack, the driver's phone) are **inputs** to the core. Their messages are verified, deduplicated and then applied as commands. They never write state directly, and the core never waits on them inside a transaction.
- One NestJS codebase with **two entrypoints**:
  - `api`: REST and webhooks. Stateless request/response, deployed as Vercel Functions.
  - `worker`: outbox relay, RabbitMQ consumers (assignment, refunds, realtime publish), timers (offer expiry, reconciliation). Deployed as a **Vercel Daemon** (a long-running container defined by a Dockerfile, restarted by Vercel if it exits).
- A small **realtime** WebSocket function for dashboard and tracking-page updates (ADR-0003).
- Modules (`orders`, `dispatch`, `payments`, `tracking`, `ledger`) talk to each other through services in-process, or through events across processes. Each module owns its own tables.
- Locally, docker compose runs `api`, `worker`, Postgres, RabbitMQ and Redis, so the failure demo can `kill -9` each one.

## Hosting fit and risks
| Piece | Vercel product | Notes |
| --- | --- | --- |
| web, api | Functions (Fluid compute) | Webhook handler acks fast; slow work goes through the outbox |
| realtime | Functions with WebSockets (public beta) | A connection closes at the function's max duration (300 s on Hobby, up to 800 s on Pro), so clients reconnect and resync; fan-out goes through Redis |
| worker | Daemons (public beta) | Production deployments only; no inbound traffic; SIGTERM with a 30 s default grace period on deploys, so the worker stops taking new messages and drains; instances "can stop at any time", which the idempotent design already assumes |
| data | Neon (PostGIS), Upstash Redis, CloudAMQP | Marketplace integrations where available |

Risks, checked in a week-1 spike before anything depends on them:
1. **Outbound AMQP from a Daemon.** The docs list queue consumers (SQS, Kafka, Redis, BullMQ) as intended uses but don't name RabbitMQ. If it doesn't work, the fallback is **Vercel Queues** (durable topics, at-least-once, delays, idempotency keys) behind the same relay and consumer adapters (ADR-0005).
2. **NestJS WebSockets on Vercel.** The guide lists Express, Hono and Next.js. The realtime endpoint is therefore a small plain-Node/Hono function, not a NestJS gateway. If the beta is a problem, server-sent events cover the downlink.
3. **Hobby quotas.** A Daemon on Hobby gets 5 active CPU-hours and 420 GB-hours of memory a month (about 17 days for a 1 GiB instance). The relay uses Postgres `LISTEN/NOTIFY` plus a slow safety poll instead of tight polling, to keep CPU low.

## Alternatives considered
- **Microservices** (orders/payments/dispatch as separate services): more realistic-looking, but each service needs its own deployment, contracts and distributed transactions, and that work would crowd out the correctness work the project is meant to show. The module boundaries and event contracts make a later split possible.
- **A container host (Railway/Fly.io) for api and worker:** fewer beta features, but adds a second platform. Kept as the fallback if the spike fails.
- **Single process:** simplest, but then "kill the worker mid-delivery" can't be demoed, and long-running consumers would compete with HTTP latency.

## Consequences
- Correctness rests on Postgres transactions, unique constraints and optimistic locking, all of which are easy to test.
- One platform for everything, with two beta features (WebSockets, Daemons) that are de-risked first.
- Preview deployments don't run the Daemon; previews are for UI only, and the full stack runs locally or in production.
