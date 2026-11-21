# Builds the api, worker, realtime server and Paystack simulator (one image, different commands).
# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @waybill/api... --ignore-scripts
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @waybill/shared build && pnpm --filter @waybill/api build
RUN pnpm --filter @waybill/api deploy --prod --legacy /out && cp -r apps/api/dist apps/api/migrations /out/

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out /app
USER node
CMD ["node", "dist/main.js"]
