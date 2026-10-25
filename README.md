# Commerce Platform

A small, observable, local-first e-commerce backend built to generate realistic, reproducible operational incidents.

It is the first of two repositories in an AI engineering portfolio. The second, the **Engineering Operations AI Agent**, consumes the telemetry and incident bundles produced here to practice detection, diagnosis, and remediation. This repository contains no AI code.

## Status

- **M0, Foundation, and M1, Skeleton, schema, and health:** done.
- **M2, Working commerce flow:** done. All 36 acceptance criteria pass, and GitHub Actions is green for the M2 commit.
- **M3a, Telemetry foundation:** done. All six M3a criteria pass, and GitHub Actions is green for commit `9a73939`.
  - With Compose, the apps send traces through an OpenTelemetry Collector to Jaeger at http://localhost:16686, and Prometheus runs at http://localhost:9090.
  - JSON logs carry `trace_id` and `span_id` inside a request.
- **M3b, Order trace correlation:** done. Implemented in commit `78f0793`. GitHub Actions is green for commit `8a0a941`, which includes it, as confirmed by the repository owner.
  - Every worker pass is its own trace, linked to the order's creation trace.
  - Searching Jaeger by `order.id` finds the creation trace and every pass trace.
- **M3c, Metrics:** done. GitHub Actions is green for commit `8a0a941`, as confirmed by the repository owner. The live Compose checks for criteria 15 and 16 last ran before a final hardening pass, which changed only error reporting, a default constant and tests, and have not been rerun.
  - Request, connection-pool, order-status, worker-pass, payment and claim metrics reach Prometheus through the collector.
  - Labels come from closed sets. Order ids, SKUs, raw URLs and payment references are never labels.
- **M4, Load generation:** done. Implemented in commit `5f6f6eb`, and GitHub Actions is green for it, as confirmed by the repository owner. All 12 acceptance criteria pass. The local performance check, criterion 11, passed on its first run: 55.00 rps with a load-generator p95 of 8.2 ms and no failures. The full results are in [docs/roadmap.md](docs/roadmap.md).
  - `pnpm loadgen` runs seeded, deterministic traffic against the orders API. The same profile and seed always produce the same request plan and plan hash.
- **M5 and later:** not started. Fault injection, incident bundles and the UI are still to come.

See [docs/roadmap.md](docs/roadmap.md) for milestone boundaries and acceptance criteria.

## What exists today

- **Orders API** (`apps/orders-api`, port 3000):
  - `GET /products`, with cursor pagination by SKU;
  - `POST /orders`, with optional `Idempotency-Key` support;
  - `GET /orders/:id`;
  - `GET /healthz` and `GET /readyz`.
- **Order worker** (`apps/worker`, health on port 3001):
  - claims orders only for free processing slots;
  - reserves stock and charges through the in-process payment simulator;
  - retries unknown outcomes, reconciles with a lookup that can void, and parks unresolved orders in `payment_unknown`;
  - shuts down without unsafe writes.
- **Database package** (`packages/db`): migrations, the deterministic seed catalog of 1,000 products, and all order SQL. The transition trigger and constraints enforce the order lifecycle.
- **Docker Compose:** Postgres 16, one-shot `migrate` and `seed` services, and both apps with health checks.
- **CI:** GitHub Actions runs format check, lint, typecheck, migrations, seed, and the test suite with its coverage gate.

The lifecycle, processing protocol, and API contracts are specified in [docs/prompts/m2-design.md](docs/prompts/m2-design.md) and summarized in [ADR 0005](docs/decisions/0005-order-processing-protocol.md).

## Planned

- **M5:** seeded fault scenarios that produce incident bundles with ground truth.
- **M7:** a React UI, after the Engineering Operations AI UI. See [ADR 0004](docs/decisions/0004-frontend-sequencing.md).

## Requirements

- Node.js 24 and pnpm 12
- Docker with Docker Compose v2

No cloud accounts, API keys, or LLMs are required.

## Quick start

```sh
cp .env.example .env
pnpm install
docker compose up -d --build --wait

curl 'localhost:3000/products?limit=3'
curl -i -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"items":[{"sku":"SKU-00042","quantity":2}],"paymentMethod":"pm_card_ok"}'
curl localhost:3000/orders/<id from the Location header>
```

The `paymentMethod` field chooses the simulated outcome:

- `pm_card_ok` is approved, and the order is `paid` within about a second.
- `pm_card_declined` fails the order with `payment_declined`.
- `pm_card_unavailable` is retried 3 times, then voided, so the order fails with `max_attempts_exceeded`.

Every 100th SKU has a stock of 3, so `out_of_stock` is easy to trigger.

To run the apps on the host against the Compose database instead:

```sh
docker compose up -d --wait postgres
pnpm build && pnpm db:migrate && pnpm db:seed
pnpm dev
```

## Commands

| Command                             | Purpose                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm build`                        | Compile all workspace projects with TypeScript project references.                            |
| `pnpm dev`                          | Run both apps in watch mode against workspace source.                                         |
| `pnpm lint`                         | Build types, then run type-aware ESLint.                                                      |
| `pnpm typecheck`                    | Type-check source and tests.                                                                  |
| `pnpm format` / `pnpm format:check` | Apply or check Prettier formatting.                                                           |
| `pnpm db:migrate`                   | Apply pending migrations to `DATABASE_URL`.                                                   |
| `pnpm db:seed`                      | Insert the 1,000-product catalog. Existing SKUs are never changed.                            |
| `pnpm test`                         | Run unit and integration tests. Requires Postgres and `TEST_DATABASE_URL`.                    |
| `pnpm test:coverage`                | Run the tests with the per-module 80% line coverage gate, as CI does.                         |
| `pnpm test:smoke`                   | Run the telemetry smoke tests under the production `--import` preload.                        |
| `pnpm e2e:jaeger`                   | Local only: check that an order's creation and pass traces are findable and linked in Jaeger. |
| `pnpm e2e:prometheus`               | Local only: check that the metric catalog reaches Prometheus with the expected labels.        |
| `pnpm loadgen`                      | Run a seeded load profile against the orders API, or print its plan hash with `--dry-run`.    |

`pnpm e2e:jaeger` needs the Compose stack running with telemetry (`docker compose up -d --build --wait`) and `DATABASE_URL` pointing at its Postgres, as the default `.env` does. It places one order and exits 1 with diagnostics if the traces are missing or unlinked. It is not part of CI.

`pnpm e2e:prometheus` needs the same running stack. It places three orders, one rejected order and one request to an unknown URL, then waits up to 30 seconds for the expected series. It exits 1 with diagnostics if a series, a label, or the `job` and `instance` labels are wrong. It is not part of CI.

`pnpm loadgen --profile steady --seed 42` needs a build (`pnpm build`) and a running orders API at `ORDERS_API_URL`, default `http://localhost:3000`. Both flags are required.

- `--dry-run` prints the entry count, the mix and the plan hash, and sends nothing. `--json` prints a machine-readable report.
- A live run first checks the API's `/readyz`, the catalog, and that at most 5% of the planned order-item quantity is short of current stock. It then offers 55 requests per second for 65 seconds and reports offered, sent, successful, failed, missed and skipped requests, throughput, failure rate and latency. It exits 1 if throughput is under 50 rps, p95 is 200 ms or more, or failures are 1% or more.
- A steady run with seed 42 creates 923 real orders for 2,771 units of stock. `pnpm db:seed` never restores stock, and the load generator never resets or reseeds the database; recreating it is a manual step.

The design is in [docs/prompts/m4-design.md](docs/prompts/m4-design.md).

Worker settings, such as concurrency, timeouts, retry limits, and backoff, are documented in `.env.example`. The worker refuses to start with an unsafe combination, for example a claim timeout shorter than 1.5 times its processing budget.

## Layout

```
apps/orders-api      HTTP API: routes, validation, pricing
apps/worker          slot-based loop, processor, payment simulator, shutdown
packages/db          migrations, seed, and all order data access
infra/postgres/init  creates the commerce_test database on first start
docs/                architecture, roadmap, ADRs, design and prompts
```

## Documentation

- [Architecture](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Decision records](docs/decisions/)
- [M2 design](docs/prompts/m2-design.md)
- [Engineering rules](CLAUDE.md)
