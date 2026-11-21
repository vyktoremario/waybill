# Deploying Waybill

Everything deploys to the personal Vercel account (`vyktoremario`, Hobby plan), with managed data services.

| Piece | How | Notes |
| --- | --- | --- |
| `apps/web` | Vercel project, root directory `apps/web` (Next.js, detected) | Env: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_REALTIME_URL` |
| `apps/api` (REST + webhooks) | Vercel project, root directory `apps/api` (NestJS, detected; no adapter needed) | Build command `pnpm vercel-build` builds the shared package and runs migrations. Set `MIGRATE_ON_START=0` |
| realtime (WebSocket) | Vercel Function with WebSocket support (public beta), or an always-on host | Connections close at the function's max duration (300 s on Hobby); clients reconnect and resync |
| worker | Vercel Daemon (public beta) from `apps/api/Dockerfile`, command `node dist/worker.js`; fallback Railway or Fly.io | Must stay connected to RabbitMQ. Hobby quota is about 17 days a month for a 1 GiB instance, so run it while demoing |
| Postgres + PostGIS | Neon (Vercel Marketplace) | Run `CREATE EXTENSION postgis;` once (the first migration also does it) |
| Redis | Upstash (Vercel Marketplace) | Use the TCP `rediss://` URL (pub/sub) |
| RabbitMQ | CloudAMQP free plan | `AMQP_URL` |
| Payments | Paystack test mode | Webhook URL in the Paystack dashboard: `https://<api>/webhooks/paystack` |

Backend environment variables: `DATABASE_URL`, `AMQP_URL`, `REDIS_URL`, `JWT_SECRET`, `PIN_SECRET`, `WEB_URL`, `PAYSTACK_BASE_URL=https://api.paystack.co`, `PAYSTACK_SECRET_KEY=sk_test_…`, `MIGRATE_ON_START=0`, plus the timings in `apps/api/.env.example` if you want to change them.

## Live (Hobby plan, region fra1)

| Piece | URL / where |
| --- | --- |
| Web | https://waybill-abuja.vercel.app (project `waybill-web`, root `apps/web`) |
| API | https://waybill-api.vercel.app (project `waybill-api`, root `apps/api`, NestJS 11 on Vercel's NestJS support) |
| Realtime | wss://waybill-realtime.vercel.app/api/ws (project `waybill-realtime`, root `apps/realtime`, WebSocket Function) |
| Worker | Vercel Daemon `worker` in `waybill-api` (see `apps/api/vercel.json`), 1 × 1 GiB in fra1 |
| Data | Neon `waybill-db`, Upstash `waybill-redis` (both connected to `waybill-api` and `waybill-realtime`), CloudAMQP |
| Paystack webhook | `https://waybill-api.vercel.app/webhooks/paystack` (set in the Paystack dashboard, test mode) |

Deploy from the repo root (the projects are not Git-connected yet):

```bash
VERCEL_ORG_ID=<team id> VERCEL_PROJECT_ID=<project id> vercel deploy --prod
```

What it took on Vercel:
- NestJS 12 and `jose` 6 are ES-module-only, and Vercel's function loader does not `require()` ES modules, so the api uses NestJS 11 and `jose` 5 (CommonJS). `node --no-experimental-require-module dist/main.js` reproduces the check locally.
- The entry file (`src/main.ts`) must import NestJS and export nothing.
- The worker uses `DATABASE_URL_UNPOOLED`: the outbox relay needs `LISTEN/NOTIFY` and migrations take a session advisory lock, which a transaction pooler breaks.
- The Daemon's `root` is `../..` so its Docker build context is the repo root, which the Dockerfile expects.
- Hobby: a 1 GiB Daemon gets about 17 days a month. Stop it between demos with `vercel daemons scale worker fra1=0`, start it with `fra1=1`.

## Status

Live. See the table above.
