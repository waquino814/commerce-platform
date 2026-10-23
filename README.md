# Commerce Platform

A small, observable, local-first e-commerce backend built to generate realistic, reproducible operational incidents.

It is the first of two repositories in an AI engineering portfolio. The second, the **Engineering Operations AI Agent**, consumes the telemetry and incident bundles produced here to practice detection, diagnosis, and remediation. This repository contains no AI code.

## Status

- **M0, Foundation:** documentation, engineering rules, and ADRs are done. The first commit is pending.
- **M1, Skeleton, schema, and health:** implemented and verified locally. The GitHub Actions run has not happened yet, because the repository has not been pushed.
- **M2 and later:** not started. There are no commerce endpoints yet, and the worker only claims orders.

See [docs/roadmap.md](docs/roadmap.md) for milestone boundaries and acceptance criteria.

## What exists today

- **Orders API** (`apps/orders-api`): Fastify service with `GET /healthz` and `GET /readyz` on port 3000.
- **Order worker** (`apps/worker`): polls Postgres and claims `pending` orders, moving them to `processing`. It has health endpoints on port 3001.
- **Database package** (`packages/db`): SQL migrations, migration runner, pool factory, readiness ping, and the order claim query.
- **Docker Compose:** Postgres 16, a one-shot `migrate` service, and both apps with health checks.
- **CI:** a GitHub Actions workflow that runs format check, lint, typecheck, migrations, and tests.

## Planned

- **M2:** catalog and order endpoints, plus inventory reservation and simulated payment in the worker.
- **M3:** OpenTelemetry traces, metrics, and logs, collected locally.
- **M4:** a deterministic load generator.
- **M5:** seeded fault scenarios that produce incident bundles with ground truth.

## Requirements

- Node.js 24 and pnpm 12
- Docker with Docker Compose v2

No cloud accounts, API keys, or LLMs are required.

## Quick start

```sh
cp .env.example .env
pnpm install

# Full stack in containers
docker compose up -d --build --wait
curl localhost:3000/readyz      # {"status":"ready"}
curl localhost:3001/readyz      # {"status":"ready"}

# Or run the apps on the host against the Compose database
docker compose up -d --wait postgres
pnpm build && pnpm db:migrate
pnpm dev
```

## Commands

| Command                             | Purpose                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `pnpm build`                        | Compile all workspace projects with TypeScript project references.         |
| `pnpm dev`                          | Run both apps in watch mode against workspace source.                      |
| `pnpm lint`                         | Build types, then run type-aware ESLint.                                   |
| `pnpm typecheck`                    | Type-check source and tests.                                               |
| `pnpm format` / `pnpm format:check` | Apply or check Prettier formatting.                                        |
| `pnpm db:migrate`                   | Apply pending migrations to `DATABASE_URL`.                                |
| `pnpm test`                         | Run unit and integration tests. Requires Postgres and `TEST_DATABASE_URL`. |

## Layout

```
apps/orders-api      HTTP service
apps/worker          order-processing worker
packages/db          migrations, runner, pool, data access
infra/postgres/init  creates the commerce_test database on first start
docs/                architecture, roadmap, ADRs, prompts
```

## Documentation

- [Architecture](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Decision records](docs/decisions/)
- [Engineering rules](CLAUDE.md)
