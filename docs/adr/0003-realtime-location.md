# ADR-0003: Real-time location: HTTPS uplink, WebSocket downlink

Status: proposed · Date: 2026-11-21

## Context
Three views need live data: the dispatcher map (all drivers and all order status changes), a customer tracking page (one order; the driver's position only after pickup), and the driver app (offers and cancellations pushed to it). Drivers are on flaky mobile data. The backend runs on Vercel Functions (ADR-0001), where WebSocket connections are supported (public beta) but close when the function reaches its maximum duration (300 s on Hobby, up to 800 s on Pro), and new connections may land on any instance.

## Decision
- **Uplink (driver → server) is plain HTTPS**, not a socket: `POST /driver/locations` with a batch of points `{seq, recordedAt, lat, lng, accuracy, speed, heading, orderId?}`. The app sends every 5 s while moving (or after ≥ 25 m) and every 30 s when stationary. The same endpoint flushes the offline buffer after reconnecting (ADR-0006), so there is one code path for online and offline. Device seq and timestamps let the server drop out-of-order points (`seq ≤ lastSeq`) and tell late points from live ones.
- **Ingest** (in `api`): validate (zod, plausible speed), then
  1. `GEOADD drivers:live` + `HSET driver:{id}` with a TTL in Redis (latest position and presence; also used by assignment),
  2. if the point is fresh (< 30 s old), `PUBLISH` it to the Redis channels `rt:dispatch` and, during an active leg, `rt:order:{orderId}`,
  3. `INSERT` the batch into `location_points` (breadcrumbs).
  Location is **not** sent through RabbitMQ. It's high-volume, losing a point is harmless, and only the latest value matters.
- **Downlink is a WebSocket** served by a small realtime function (plain Node/Hono, not a NestJS gateway, to match what Vercel's WebSocket support lists). Each instance subscribes to the Redis channels of the rooms its clients joined and forwards messages. Because any instance can serve any client and connections are cut at the max duration, no state lives in the instance.
- **Protocol:** a thin JSON envelope `{type, room, seq, data}` over plain WebSocket. No Socket.IO: its multi-instance adapter and sticky-session assumptions don't fit short-lived serverless connections. The client library (shared by web and driver app) reconnects with jittered backoff, re-joins its rooms, and **refetches a REST snapshot** on every (re)connect, so a gap during a reconnect never leaves the screen wrong.
- **Status updates** (order transitions) come from the outbox → RabbitMQ → a worker consumer that publishes to the same Redis channels. That makes status pushes as reliable as the event log.
- **Rooms and authorization** (checked when the connection opens and on every `join`):
  - `dispatch`: dispatcher JWT.
  - `order:{id}`: the tracking token (an opaque 128-bit random value; only its hash is stored; scoped to one order; expires 24 h after a terminal state). Positions go to this room only while the order is `PICKED_UP` or `EN_ROUTE_TO_DROPOFF`. Before that the page shows status only, which protects the driver's location.
  - `driver:{id}`: the driver's own JWT, for offers and cancellations.

## Alternatives considered
- **Driver uplink over WebSocket:** saves a little overhead, but a second code path for offline flushes, and sockets on mobile data reconnect constantly. HTTPS batches are simpler and just as fast at a 5 s interval.
- **Server-sent events for the downlink:** a good fit (downlink only) and the fallback if WebSockets on Vercel misbehave. WebSockets are the primary choice because they were asked for, and they leave room for client → server messages later (e.g. dispatcher "ping driver").
- **Managed realtime (Ably/Pusher):** less to run, but it hides exactly the part this project is meant to show. The client library is small enough to swap.
- **Writing every point to Postgres and polling:** too much load and latency.

## Consequences
- Clients must handle reconnects as routine (every few minutes on Hobby). That's tested, not treated as an edge case.
- Tracking pages can't be used to follow a driver outside an active leg.
- Load test target for the README: N simulated drivers at one point every 5 s against the deployed stack. The number will be measured, not guessed.
