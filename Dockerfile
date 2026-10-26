# One image for every service. Compose selects the entrypoint per service.

FROM node:24-slim AS base
RUN npm install --global pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/orders-api/package.json apps/orders-api/
COPY apps/worker/package.json apps/worker/
# Host tools: built with the workspace (the root build references them), but not part of the
# runtime image.
COPY apps/loadgen/package.json apps/loadgen/
COPY apps/incident/package.json apps/incident/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/incident-bundle/package.json packages/incident-bundle/
COPY packages/faults/package.json packages/faults/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json ./
COPY packages/db packages/db
COPY packages/telemetry packages/telemetry
COPY packages/incident-bundle packages/incident-bundle
COPY packages/faults packages/faults
COPY apps/orders-api apps/orders-api
COPY apps/worker apps/worker
COPY apps/loadgen apps/loadgen
COPY apps/incident apps/incident
COPY apps/web apps/web
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/packages/db packages/db
COPY --from=prod-deps /app/packages/telemetry packages/telemetry
COPY --from=prod-deps /app/packages/incident-bundle packages/incident-bundle
COPY --from=prod-deps /app/packages/faults packages/faults
COPY --from=prod-deps /app/apps/orders-api apps/orders-api
COPY --from=prod-deps /app/apps/worker apps/worker
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/telemetry/dist packages/telemetry/dist
COPY --from=build /app/packages/incident-bundle/dist packages/incident-bundle/dist
COPY --from=build /app/packages/faults/dist packages/faults/dist
COPY --from=build /app/apps/orders-api/dist apps/orders-api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY packages/db/migrations packages/db/migrations
USER node
