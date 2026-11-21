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

## Status

Not deployed yet. Waiting for the Neon, Upstash and CloudAMQP connection strings and the Paystack test key.
