# One image for every service. Compose selects the entrypoint per service.

FROM node:24-slim AS base
RUN npm install --global pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/orders-api/package.json apps/orders-api/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json ./
COPY packages/db packages/db
COPY apps/orders-api apps/orders-api
COPY apps/worker apps/worker
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/packages/db packages/db
COPY --from=prod-deps /app/apps/orders-api apps/orders-api
COPY --from=prod-deps /app/apps/worker apps/worker
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/apps/orders-api/dist apps/orders-api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY packages/db/migrations packages/db/migrations
USER node
