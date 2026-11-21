#!/usr/bin/env bash
# Runs the whole stack on the host for development: infra in Docker, everything else with live reload.
set -euo pipefail
cd "$(dirname "$0")/.."
WEB_PORT="${WEB_PORT:-3000}"
docker compose up -d --wait
pnpm --filter @waybill/shared build
pnpm --filter @waybill/api seed
export WEB_URL="http://localhost:${WEB_PORT}"
trap 'kill 0' EXIT
pnpm --filter @waybill/api dev:api &
pnpm --filter @waybill/api dev:worker &
pnpm --filter @waybill/api dev:realtime &
pnpm --filter @waybill/api dev:paystack-sim &
pnpm --filter @waybill/web exec node scripts/copy-maplibre-worker.mjs
pnpm --filter @waybill/web exec next dev -p "$WEB_PORT" &
wait
