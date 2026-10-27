# Commerce Platform

A small, observable, local-first e-commerce backend built to generate realistic, reproducible operational incidents, with two web UIs: a customer storefront and a read-only incident dashboard.

It is the first of two repositories in an AI engineering portfolio. The second, [Engineering Operations AI](https://github.com/waquino814/engineering-operations-ai), consumes the incident bundles produced here to practise detection, diagnosis and remediation. **This repository contains no AI code, makes no LLM or cloud calls, and needs no accounts or API keys.** The only contract between the two is the incident bundle ([handoff](docs/incidents-and-handoff.md)).

![The incident dashboard showing a provider-outage run: ground truth, the primary-symptom series with fault and detection markers, traces, logs and validation](docs/images/dashboard-02-incident-provider-outage.png)

## What problem it solves

Testing an incident-investigation system needs incidents with known causes. This project runs a believable order workload (API, background worker, PostgreSQL, a payment simulator), injects a named fault with a seed, exports the traces, metrics and logs an on-call engineer would see, and writes the **ground truth** of what actually broke next to them. Everything is deterministic for a scenario name plus a seed, and every fault is inert unless explicitly enabled.

## Status

[docs/roadmap.md](docs/roadmap.md) is the source of truth. Summary (2026-10-27):

| Milestone                                                                          | State                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 Foundation, M1 Skeleton, M2 Commerce flow, M3 Observability, M4 Load generation | Done. CI green for their commits, as confirmed by the repository owner.                                                                                                                                                                                                                                                                                                                                                                  |
| M5 Fault scenarios and incident bundles                                            | **Open.** M5a to M5c (scenarios, bundle schema, validator and writer, incident CLI) are committed with CI confirmed by the owner. Its live criteria (C3 to C5) need owner-approved live runs. Per the roadmap, four scenarios have passed C3; `provider-outage`, the C4 reruns and direct C5 evidence for `payment-timeouts` and `api-pool-exhaustion` remain. See [docs/prompts/m5c-design.md](docs/prompts/m5c-design.md), section 14. |
| M6 Portfolio polish                                                                | Not started (this README, the screenshots and docs index are documentation groundwork, not M6's acceptance criteria).                                                                                                                                                                                                                                                                                                                    |
| M7 Commerce UI                                                                     | **Started early, by the owner's decision:** a read-only incident dashboard (`apps/web`) and the storefront (`apps/commerce-web`). Open: Compose hosting, scenario controls, an end-to-end test against the running stack.                                                                                                                                                                                                                |

Known limitations: the UIs run on the host, not through Compose; the storefront has no fault or scenario controls and the dashboard cannot start runs; there is no customer identity, so the order history lists every order; the default Compose file publishes service ports on all interfaces (see [Ports](#ports)).

## Main capabilities

- **Orders API** (`apps/orders-api`, port 3000): `GET /products`, `POST /orders` with optional `Idempotency-Key`, `GET /orders` (history, cursor pagination, `status` filter, `q` search), `GET /orders/:id`, `GET /healthz`, `GET /readyz`.
- **Order worker** (`apps/worker`, health on 3001): claims orders only for free slots, reserves stock, charges through an in-process payment simulator, retries unknown outcomes, reconciles with a lookup that can void, and parks unresolved orders in `payment_unknown`.
- **Telemetry:** OpenTelemetry traces and metrics through a collector to Jaeger and Prometheus; JSON logs carrying `trace_id`.
- **Load generation** (`pnpm loadgen`): seeded, deterministic traffic profiles.
- **Fault scenarios and incident bundles** (`pnpm incident`): five scenarios, each reproducible from a name plus a seed, written as validated bundles with ground truth.
- **Storefront** (`apps/commerce-web`): catalog, product search, order form, order history, live order status.
- **Incident dashboard** (`apps/web`): lists incident bundles and shows ground truth, primary-symptom series, traces, logs and component health. Read-only.

## Screenshots

Captured from the running stack on 2026-10-27. The incident runs, orders and stock figures are real local data from earlier runs; nothing was fabricated. Every route and state is listed in [docs/ui-visual-qa.md](docs/ui-visual-qa.md).

|                                                                                                                                                                                                                                 |                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ![Storefront: catalog of 12 products with stock, and the order form with test payment methods](docs/images/storefront-01-shop.png)<br>**Storefront.** Catalog, cart and the three simulated payment outcomes.                   | ![Storefront order history listing orders newest first with status filters](docs/images/storefront-04-orders.png)<br>**Order history.** Search and status filters over every order. |
| ![A paid order with a progress tracker, items and details](docs/images/storefront-06-order-paid.png)<br>**Order detail.** Status, items, timestamps; polls until `paid` or `failed`.                                            | ![A failed order: payment declined](docs/images/storefront-07-order-payment-declined.png)<br>**Failed order.** The failure reason is stated plainly.                                |
| ![Incident dashboard overview listing eight runs with scenario, seed, detection and validation](docs/images/dashboard-01-incidents.png)<br>**Incidents.** Eight local runs across five scenarios, including one "not detected". | ![System health: orders API, worker, Prometheus and Jaeger readiness](docs/images/dashboard-08-health.png)<br>**System health.** Each component's own readiness endpoint, live.     |

More: [incident detail per scenario](docs/images/dashboard-04-incident-payment-timeouts.png), [empty dashboard](docs/images/dashboard-09-incidents-empty.png), [health with components down](docs/images/dashboard-10-health-unreachable.png), [order rejected by the API](docs/images/storefront-03-order-validation.png), and mobile captures such as [the storefront](docs/images/storefront-mobile-shop.png).

## Technology

TypeScript 6.0 (strict) on Node.js 24, pnpm 12 workspaces; Fastify and Zod; PostgreSQL 16 with plain forward-only SQL migrations; OpenTelemetry, Jaeger, Prometheus; React, Vite and Tailwind CSS for both UIs; ESLint, Prettier and Vitest ([engineering rules](CLAUDE.md), [ADR 0001](docs/decisions/0001-local-first-architecture.md)).

## Prerequisites

| Tool                   | Version                                    | Verified with |
| ---------------------- | ------------------------------------------ | ------------- |
| Node.js                | `>=24 <25` (`.nvmrc` is `24`)              | v24.20.0      |
| pnpm                   | `12.15.0` (`packageManager`; use Corepack) | 12.15.0       |
| Docker with Compose v2 | any recent                                 | Docker 29.7.2 |

No cloud account, API key or LLM is needed.

## Install and start

```sh
corepack enable
cp .env.example .env                  # local development values; never commit .env
pnpm install --frozen-lockfile
docker compose up -d --build --wait   # postgres, migrate, seed, orders-api, worker, collector, jaeger, prometheus
```

`--wait` returns when every service is healthy. The one-shot `migrate` and `seed` services apply the SQL migrations and insert the deterministic 1,000-product catalog before the apps start. Check it:

```sh
curl 'localhost:3000/products?limit=3'
curl -i -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"items":[{"sku":"SKU-00042","quantity":2}],"paymentMethod":"pm_card_ok"}'
curl localhost:3000/orders/<id from the Location header>
```

That `POST` creates a real order on your local database and uses stock. The `paymentMethod` field chooses the simulated outcome:

- `pm_card_ok`: approved; the order is `paid` within about a second.
- `pm_card_declined`: the order fails with `payment_declined`.
- `pm_card_unavailable`: retried 3 times, then voided; fails with `max_attempts_exceeded`.

Every 100th SKU has a stock of 3, so `out_of_stock` is easy to trigger.

To run the apps on the host against the Compose database instead:

```sh
docker compose up -d --wait postgres
pnpm build && pnpm db:migrate && pnpm db:seed
pnpm dev                              # both apps in watch mode
```

### Start the two UIs

Both run on the host, not in Compose, and need `pnpm build` first for the production variants.

```sh
pnpm build                  # compiles everything and builds both UI clients
pnpm web                    # incident dashboard: http://127.0.0.1:3100
pnpm commerce:preview       # storefront (production build): http://127.0.0.1:4174
# or, with hot reload:
pnpm commerce:dev           # storefront: http://127.0.0.1:5174
pnpm web:dev                # dashboard client: http://127.0.0.1:5173 (needs `pnpm web` running)
```

The storefront calls same-origin `/api/*`; the Vite dev and preview servers proxy it to `ORDERS_API_URL` (default `http://127.0.0.1:3000`). It needs the orders API running. The dashboard works without the stack: incident views read bundles from `INCIDENTS_DIR`, and the health view reports each component as unreachable.

### Environment

`.env.example` documents every setting with safe local values (the Postgres credentials are development-only: `commerce` / `commerce`). Main ones:

| Variable                                                                                           | Default                                                                        | Meaning                                                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `TEST_DATABASE_URL`                                                                | `postgres://commerce:commerce@localhost:5432/commerce` and `.../commerce_test` | Runtime and test databases.                                                                               |
| `POSTGRES_PORT`                                                                                    | `5432`                                                                         | Host port for Compose Postgres.                                                                           |
| `PORT`, `HEALTH_PORT`                                                                              | `3000`, `3001`                                                                 | Orders API and worker health ports.                                                                       |
| `FAULTS_ENABLED`                                                                                   | `false`                                                                        | Only makes the scenario control endpoints exist; a scenario still needs an explicit start.                |
| `WORKER_CONCURRENCY`, `CLAIM_TIMEOUT_MS`, `MAX_CHARGE_ATTEMPTS`, retry settings                    | see file                                                                       | The worker refuses an unsafe combination, such as a claim timeout under 1.5 times its processing budget.  |
| `OTEL_*`                                                                                           | see file                                                                       | Telemetry export; off unless an OTLP endpoint is configured.                                              |
| `WEB_PORT`, `INCIDENTS_DIR`, `ORDERS_API_URL`, `WORKER_HEALTH_URL`, `PROMETHEUS_URL`, `JAEGER_URL` | `3100`, `incidents`, loopback URLs                                             | Dashboard settings (commented in `.env.example`); upstream URLs must be `http` on `127.0.0.1` or `[::1]`. |
| `VITE_API_BASE_URL`                                                                                | unset                                                                          | Build-time storefront API base URL; the API would then need to allow that origin.                         |

### Ports

| Port         | Service                                      | Notes                      |
| ------------ | -------------------------------------------- | -------------------------- |
| 3000         | Orders API                                   |                            |
| 3001         | Worker health                                | `/healthz`, `/readyz` only |
| 5432         | PostgreSQL 16                                | `POSTGRES_PORT`            |
| 4318, 13133  | OTLP collector (HTTP), collector health      |                            |
| 16686, 13134 | Jaeger UI, Jaeger health                     |                            |
| 9090         | Prometheus                                   |                            |
| 3100         | Incident dashboard (`pnpm web`)              | binds `127.0.0.1` only     |
| 5173         | Dashboard client dev server (`pnpm web:dev`) |                            |
| 5174, 4174   | Storefront dev and preview servers           | `127.0.0.1`                |

**Exposure.** `compose.yaml` publishes the Compose service ports on all interfaces, including Postgres with the development password. `compose.faults.yaml`, the override used for incident runs, binds the API, worker, Jaeger and Prometheus to `127.0.0.1` (Postgres and the collector are not rebound). On a shared or untrusted network, do not run the default file as is.

## Commands

| Command                                                             | Purpose                                                                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                                        | Compile all projects (`tsc -b`) and build both UI clients.                                                                          |
| `pnpm dev`                                                          | Run both backend apps in watch mode against source.                                                                                 |
| `pnpm format` / `pnpm format:check`                                 | Apply or check Prettier.                                                                                                            |
| `pnpm lint` / `pnpm typecheck`                                      | Type-aware ESLint (builds types first); type-check source, tests and both clients.                                                  |
| `pnpm db:migrate` / `pnpm db:seed`                                  | Apply migrations; insert the catalog (existing SKUs are never changed, stock is never restored).                                    |
| `pnpm test` / `pnpm test:coverage`                                  | Unit and integration tests, with the per-module 80% line coverage gate. Need Compose Postgres and `TEST_DATABASE_URL`.              |
| `pnpm test:smoke`                                                   | Telemetry, load-generator and fault-leakage smoke tests under the production `--import` preload.                                    |
| `pnpm e2e:jaeger`, `pnpm e2e:prometheus`                            | **Local only, mutate data:** place orders against the running stack and check traces or metrics arrive. Not part of CI.             |
| `pnpm loadgen --profile steady --seed 42 [--dry-run] [--json]`      | Seeded load. **A live run creates about 923 real orders** and uses 2,771 units of stock; `--dry-run` sends nothing.                 |
| `pnpm incident <command>`                                           | `list`, `ground-truth`, `validate`, `capture-check`, `run`. See [incidents](docs/incidents-and-handoff.md); `run` is consequential. |
| `pnpm web`, `pnpm web:dev`, `pnpm web:build`                        | Incident dashboard server, client dev server, client build.                                                                         |
| `pnpm commerce:dev`, `pnpm commerce:build`, `pnpm commerce:preview` | Storefront dev server, build, preview of the build.                                                                                 |

Command details and their safety notes: [docs/incidents-and-handoff.md](docs/incidents-and-handoff.md), [docs/prompts/m4-design.md](docs/prompts/m4-design.md) (load generation), [docs/prompts/m5c-design.md](docs/prompts/m5c-design.md) (incident CLI).

## Tests and quality gates

```sh
docker compose up -d --wait postgres    # tests need Postgres (and the init script creates commerce_test)
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm test:smoke
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs install with the frozen lockfile, format check, lint, typecheck, migrations, seed, `test:coverage` and `test:smoke` against a Postgres service container, on every push and pull request. UI tests run in jsdom against a stubbed `fetch`; they are part of `pnpm test`.

## Stop

```sh
docker compose down        # stops and removes containers; keeps the database volume
```

`docker compose down -v` also **deletes the database volume** (all orders and the seeded catalog); recreating it is a manual step. Stop `pnpm web`, `pnpm commerce:dev`, `pnpm commerce:preview` and `pnpm dev` with Ctrl-C.

## Troubleshooting

| Symptom                                                                | Fix                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port 5432 already in use                                               | Set `POSTGRES_PORT` in `.env`, and update `DATABASE_URL` / `TEST_DATABASE_URL` to match.                                                                                                              |
| Tests fail to connect                                                  | `docker compose up -d --wait postgres`, and check `TEST_DATABASE_URL` in `.env`.                                                                                                                      |
| `pnpm incident` or `pnpm loadgen` says a file under `dist/` is missing | Run `pnpm build` first.                                                                                                                                                                               |
| Storefront shows errors loading products or orders                     | The orders API is not running or not reachable at `ORDERS_API_URL`; start the stack. The order history needs an API built from this version (`GET /orders` is newer): `docker compose up -d --build`. |
| Dashboard health shows everything unreachable                          | The stack is not running or the URLs in `.env` do not match. Incident views still work.                                                                                                               |
| Dashboard lists no incidents                                           | `INCIDENTS_DIR` is empty or elsewhere. Bundles are not committed; see [incidents](docs/incidents-and-handoff.md).                                                                                     |
| Storefront tab has no icon                                             | Fixed 2026-10-27; rebuild with `pnpm commerce:build`.                                                                                                                                                 |
| Worker or API refuses to start                                         | Invalid configuration fails fast with a message naming the variable.                                                                                                                                  |

## Documentation

See the [documentation index](docs/README.md). Direct links: [architecture](docs/architecture.md), [incident scenarios, bundles and the handoff](docs/incidents-and-handoff.md), [UI visual QA](docs/ui-visual-qa.md), [roadmap](docs/roadmap.md), [decision records](docs/decisions/), [engineering rules](CLAUDE.md).

## Layout

```text
apps/orders-api      HTTP API: routes, validation, pricing
apps/worker          slot-based loop, processor, payment simulator, shutdown
apps/loadgen         seeded, deterministic load profiles
apps/incident        incident CLI: scenarios, capture, bundle writer
apps/web             read-only incident dashboard: Fastify JSON API and React client
apps/commerce-web    storefront: place orders, order history, live order status (static React client)
packages/db          migrations, seed, and all order data access
packages/faults      scenario registry and fault hooks; inert unless a scenario is started
packages/telemetry   OpenTelemetry setup and shared metric names
packages/incident-bundle  bundle schema, validator and writer
infra/               collector, Prometheus and Postgres init configuration
docs/                architecture, roadmap, ADRs, design documents, screenshots
```
