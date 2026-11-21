# ADR-0006: Offline-first driver app (command queue + conflict handling)

Status: proposed · Date: 2026-11-21

## Context
Drivers lose signal in basements, gated estates and on long stretches of road, and Nigerian mobile data is often slow or intermittent. A driver must be able to finish a pickup or drop-off with no signal, and their actions must reach the server **exactly once in effect**, in order, without overwriting decisions made on the server in the meantime (cancellation, reassignment).

## Decision
- **Expo (React Native)** with `expo-sqlite` for durable local state, `expo-location` (foreground while on a job; background location task during an active leg), NetInfo for connectivity, and TanStack Query for server reads.
- **Command queue:** every user action (`accept_offer`, `arrived_pickup`, `confirm_pickup{photo}`, `arrived_dropoff`, `confirm_delivery{pin}`, `report_failed_attempt{reason}`) is written to a SQLite `outbox` as `{commandId (UUIDv7), orderId, type, expectedVersion, payload, createdAt, attempts, state}` **before** the UI changes. The UI then shows the optimistic next step with a "waiting to sync" badge.
- **Sync loop:** sends commands one at a time per order, in creation order, to `POST /driver/commands`. Retries use exponential backoff with jitter (1 s → 60 s cap) and trigger immediately when NetInfo reports a connection. The server dedupes on `commandId` (ADR-0002), so a retry after a lost response returns the original result.
- **Results:**
  - `200` → mark done; adopt the server's version/state.
  - `409 Conflict` (version mismatch, or the order was cancelled/reassigned) → stop that order's queue, discard its later optimistic state, show a **"This order changed"** screen with the server's state and what happened to the queued actions. The app never tries to "win" a conflict.
  - `4xx` validation (e.g. wrong PIN) → show it inline; the command is dropped.
  - `5xx`/network → retry.
- **Offline PIN check:** the assignment payload includes `salt` and `sha256(salt‖pin)` for the delivery PIN, so the app can check it without signal and move forward. The server re-checks the raw PIN on sync. A 4-digit hash on the device can be brute-forced, so this check only exists for UX. The server's check, which is rate-limited, is the one that counts.
- **Pickup photos** are saved to the app's storage and uploaded (to a signed upload URL) when online. The pickup command references the photo by a client-generated id, so it can sync before the photo finishes uploading.
- **Location while offline:** points are stored in SQLite (capped at ~2 h at 1 per 10 s, then downsampled), uploaded in batches of 500 on reconnect via the same `POST /driver/locations` endpoint used online, and stored as history but not broadcast as live (ADR-0003).
- **Offers need connectivity:** an offer can only be accepted online, because accepting it offline would reserve work the server may have given to someone else. This is shown clearly in the UI.
- **UI rules:** a persistent connection banner (Online / Offline · N actions waiting / Syncing…), step-by-step status with large (≥ 56 pt) tap targets, every irreversible step confirmed, and the queue visible from a debug screen for the demo.

## Alternatives considered
- **Full sync engine (WatermelonDB / PowerSync / Replicache):** strong, but it syncs *data* with merge semantics. Delivery steps are *commands* that need server validation, and a command log is simpler and easier to audit.
- **Last-write-wins state upload:** this is how ghost pickups happen after cancellation. Rejected.
- **Block the UI until online:** the driver is standing in front of the customer. Not acceptable.

## Consequences
- Each order's `order_events` stores both `occurred_at` (device time) and `recorded_at` (server time), and the timeline shows "recorded 2 min later (offline)" where they differ.
- Clock skew: device timestamps are only used for display and ordering within one device. Server decisions use server time.
- Failure-demo scenarios F8/F9 exercise this end to end with a scripted "airplane mode" (a network-condition toggle in the dev build plus a CLI driver simulator for CI).
