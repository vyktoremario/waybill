# Deploying Waybill

Target (ADR-0001): everything on Vercel, with managed data services.

| Piece | Where | Notes |
| --- | --- | --- |
| `apps/web` | Vercel project (Next.js) | Env: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_REALTIME_URL` |
| api (REST + webhooks) | Vercel Functions | NestJS app from `apps/api` |
| realtime (WebSocket) | Vercel Function with WebSocket support (public beta) | Connections close at the function's max duration (300 s on Hobby); clients reconnect and resync |
| worker | Vercel Daemon (public beta), from `apps/api/Dockerfile`, command `node dist/worker.js` | Production deployments only. Hobby quota: about 17 days a month for a 1 GiB instance, so run it while demoing |
| Postgres + PostGIS | Neon (Vercel Marketplace) | Run migrations with `pnpm --filter @waybill/api migrate` against it; seed with `pnpm seed` |
| Redis | Upstash (Vercel Marketplace) | Needs a TCP `rediss://` URL for pub/sub |
| RabbitMQ | CloudAMQP free plan | Week-1 risk: confirm a Daemon can hold an AMQP connection. Fallback: Vercel Queues behind the same relay/consumer adapters (ADR-0005) |
| Payments | Paystack test mode | Set the webhook URL in the Paystack dashboard to `https://<api>/webhooks/paystack` |

Backend environment variables: `DATABASE_URL`, `AMQP_URL`, `REDIS_URL`, `JWT_SECRET`, `PIN_SECRET`, `WEB_URL`, `PAYSTACK_BASE_URL=https://api.paystack.co`, `PAYSTACK_SECRET_KEY=sk_test_…`, plus the timings in `apps/api/.env.example` if you want to change them.

## Status

Not deployed yet. Creating the Neon, Upstash and CloudAMQP resources, and the Paystack test keys, needs the account owner. See the open question in the project notes.
