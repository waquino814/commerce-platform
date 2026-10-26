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
- **M5, Fault scenarios and incident bundles:** M5a committed in `d1579ec`; CI confirmed by the repository owner on 2026-10-25. M5b, the bundle schema, validator, writer, capture clients and `incident` load profile, is committed; CI confirmed by the repository owner on 2026-10-25. M5c, the incident CLI and its orchestration, is committed; CI confirmed by the repository owner on 2026-10-25. Its runtime isolation checks pass against the local stack, and no live run has been made. See [docs/prompts/m5-design.md](docs/prompts/m5-design.md) and [docs/prompts/m5c-design.md](docs/prompts/m5c-design.md).
- **M6 and later:** not started. Portfolio polish and the UI are still to come.

See [docs/roadmap.md](docs/roadmap.md) for milestone boundaries and acceptance criteria.

## What exists today

- **Orders API** (`apps/orders-api`, port 3000):
  - `GET /products`, with cursor pagination by SKU;
  - `POST /orders`, with optional `Idempotency-Key` support;
  - `GET /orders`, the order history: all orders newest first, without items, with cursor pagination (M7);
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
- **M7:** a React UI, planned after M5 and before the separate Engineering Operations AI repository is started, as proposed in [ADR 0008](docs/decisions/0008-project-order.md).

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

| Command                             | Purpose                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm build`                        | Compile all workspace projects with TypeScript project references.                             |
| `pnpm dev`                          | Run both apps in watch mode against workspace source.                                          |
| `pnpm lint`                         | Build types, then run type-aware ESLint.                                                       |
| `pnpm typecheck`                    | Type-check source and tests.                                                                   |
| `pnpm format` / `pnpm format:check` | Apply or check Prettier formatting.                                                            |
| `pnpm db:migrate`                   | Apply pending migrations to `DATABASE_URL`.                                                    |
| `pnpm db:seed`                      | Insert the 1,000-product catalog. Existing SKUs are never changed.                             |
| `pnpm test`                         | Run unit and integration tests. Requires Postgres and `TEST_DATABASE_URL`.                     |
| `pnpm test:coverage`                | Run the tests with the per-module 80% line coverage gate, as CI does.                          |
| `pnpm test:smoke`                   | Run the telemetry smoke tests under the production `--import` preload.                         |
| `pnpm e2e:jaeger`                   | Local only: check that an order's creation and pass traces are findable and linked in Jaeger.  |
| `pnpm e2e:prometheus`               | Local only: check that the metric catalog reaches Prometheus with the expected labels.         |
| `pnpm loadgen`                      | Run a seeded load profile against the orders API, or print its plan hash with `--dry-run`.     |
| `pnpm incident`                     | M5c: list scenarios, print a ground truth, validate a bundle, check readiness, run a scenario. |
| `pnpm web`                          | M7, first slice: a read-only incident dashboard at `http://127.0.0.1:3100`.                    |
| `pnpm web:dev`                      | The dashboard client with hot reload at `http://127.0.0.1:5173`; needs `pnpm web` running.     |
| `pnpm web:build`                    | Build only the dashboard client into `apps/web/dist/client` (`pnpm build` includes it).        |
| `pnpm commerce:dev`                 | M7: the Commerce UI with hot reload at `http://127.0.0.1:5174`, proxying `/api` to the API.    |
| `pnpm commerce:build`               | Build only the Commerce UI into `apps/commerce-web/dist` (`pnpm build` includes it).           |
| `pnpm commerce:preview`             | Serve the built Commerce UI at `http://127.0.0.1:4174`, with the same `/api` proxy.            |

`pnpm e2e:jaeger` needs the Compose stack running with telemetry (`docker compose up -d --build --wait`) and `DATABASE_URL` pointing at its Postgres, as the default `.env` does. It places one order and exits 1 with diagnostics if the traces are missing or unlinked. It is not part of CI.

`pnpm e2e:prometheus` needs the same running stack. It places three orders, one rejected order and one request to an unknown URL, then waits up to 30 seconds for the expected series. It exits 1 with diagnostics if a series, a label, or the `job` and `instance` labels are wrong. It is not part of CI.

`pnpm loadgen --profile steady --seed 42` needs a build (`pnpm build`) and a running orders API at `ORDERS_API_URL`, default `http://localhost:3000`. Both flags are required.

- `--dry-run` prints the entry count, the mix and the plan hash, and sends nothing. `--json` prints a machine-readable report.
- A live run first checks the API's `/readyz`, the catalog, and that at most 5% of the planned order-item quantity is short of current stock. It then offers 55 requests per second for 65 seconds and reports offered, sent, successful, failed, missed and skipped requests, throughput, failure rate and latency. It exits 1 if throughput is under 50 rps, p95 is 200 ms or more, or failures are 1% or more.
- A steady run with seed 42 creates 923 real orders for 2,771 units of stock. `pnpm db:seed` never restores stock, and the load generator never resets or reseeds the database; recreating it is a manual step.

`pnpm incident <command>` needs a build (`pnpm build`). `list`, `ground-truth --scenario <name> --seed <n>` and `validate <bundle-dir>` make no network calls. `capture-check` is read-only: it never starts faults, services or load, and writes nothing; it exits 0 when every check passes, 1 when one fails, and 5 when none fails but some are inconclusive. `run --scenario <name> --seed <n>` runs a scenario end to end. The `docker compose ps` output, the `compose.faults.yaml` loopback binding and the API identity premise were verified on 2026-10-25. The stack can run with `compose.faults.yaml`, which binds the API, worker, Jaeger and Prometheus to `127.0.0.1`; `pnpm incident capture-check` passed all 13 checks against it on 2026-10-25, and every live run still needs the owner's separate approval. Trace volume and Jaeger capture time are not yet verified. Starting the stack with `compose.faults.yaml`, and every live run, needs the owner's separate approval. See `docs/prompts/m5c-design.md`.

The design is in [docs/prompts/m4-design.md](docs/prompts/m4-design.md).

### Incident dashboard

`apps/web` is a read-only dashboard over the incident bundles (React, TypeScript, Vite, Tailwind CSS). It lists every run in `INCIDENTS_DIR` with its scenario, detection time and validation result; shows each run's ground truth, primary-symptom series, logs, sample traces and evidence files; and shows live readiness of the orders API, worker, Prometheus and Jaeger. Everything shown comes from the bundles on disk or from the components' own endpoints at request time. It never starts a run or changes fault state.

```sh
pnpm build   # compiles the server and builds the client into apps/web/dist/client
pnpm web     # http://127.0.0.1:3100
```

For client development, run `pnpm web` (the API) and `pnpm web:dev` side by side, and open `http://127.0.0.1:5173`; Vite proxies `/api` to port 3100. The server binds only to `127.0.0.1`. Its settings (`WEB_PORT`, `INCIDENTS_DIR`, `ORDERS_API_URL`, `WORKER_HEALTH_URL`, `PROMETHEUS_URL`, `JAEGER_URL`) are in `.env.example`; upstream URLs must use `127.0.0.1` or `[::1]`. Without the stack running, the incident views still work and the health view reports each component as unreachable. Its tests run with `pnpm test`: the server against bundles written to temporary directories, the client in jsdom against a stubbed `fetch`.

Worker settings, such as concurrency, timeouts, retry limits, and backoff, are documented in `.env.example`. The worker refuses to start with an unsafe combination, for example a claim timeout shorter than 1.5 times its processing budget.

### Commerce UI

`apps/commerce-web` is the customer-facing UI (React, TypeScript, Vite, Tailwind CSS), separate from the incident dashboard. It places orders (SKU, quantity and a test payment method, from typed SKUs or the real catalog), lists the order history, and shows an order's items, totals, timestamps and status, polling `GET /orders/:id` every 2 seconds until the order is `paid` or `failed`. It is a static client: it has no fault or scenario controls and reads nothing but the orders API.

```sh
docker compose up -d --wait   # or any orders API on ORDERS_API_URL
pnpm commerce:dev             # http://127.0.0.1:5174
```

The browser calls same-origin `/api/*`; the Vite dev and preview servers proxy it to `ORDERS_API_URL` (default `http://127.0.0.1:3000`), stripping the `/api` prefix, so the API needs no CORS. To use another base URL, set `VITE_API_BASE_URL` when building (the API then needs to allow that origin). Both read the repository's `.env`. `pnpm build && pnpm commerce:preview` serves the production build at `http://127.0.0.1:4174`. Orders placed through the UI are real orders: they use stock that `pnpm db:seed` never restores. The order history needs an orders API built from this version, since `GET /orders` is new in M7. Its tests run with `pnpm test`, in jsdom against a stubbed `fetch`.

## Layout

```
apps/orders-api      HTTP API: routes, validation, pricing
apps/worker          slot-based loop, processor, payment simulator, shutdown
apps/web             read-only incident dashboard: Fastify JSON API and React client
apps/commerce-web    Commerce UI: place orders, order history, live order status (static React client)
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
