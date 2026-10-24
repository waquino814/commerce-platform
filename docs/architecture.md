# Architecture

## Goal

Run a believable commerce workload locally, inject faults on demand, and export what an on-call engineer would see, plus the ground truth of what actually broke.

## Components

Each component appears only in the milestone that gives it real code.

| Component            | Milestone | Responsibility                                                                                            | Does not                                                  |
| -------------------- | --------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/orders-api`    | M1        | Fastify HTTP API for catalog and orders. Writes orders as `pending`.                                      | Process orders inline.                                    |
| `apps/worker`        | M1        | Claims due orders for free slots only, reserves stock, charges through the payment simulator, reconciles. | Serve public traffic. It exposes health endpoints only.   |
| `packages/db`        | M1        | SQL migrations, migration runner, connection pool factory, data-access functions.                         | Contain business rules.                                   |
| `apps/loadgen`       | M4        | Seeded, deterministic traffic profiles against the orders API.                                            | Inspect internal state.                                   |
| `packages/telemetry` | M3        | OpenTelemetry SDK setup and shared metric names for both apps.                                            | Know about business logic.                                |
| fault package        | M5        | Scenario registry and injection hooks. Inert unless enabled.                                              | Change behavior by default.                               |
| incident tool        | M5        | Runs a scenario end to end and writes an incident bundle.                                                 | Analyze or diagnose incidents.                            |
| `apps/web`           | M7        | React UI for placing orders, viewing order history and status, and running demo scenarios.                | Contain business rules. It uses only the public HTTP API. |

Pure order and pricing rules start inside the app that uses them. They move to a shared package only if a second consumer appears.

## Runtime topology

Compose services: `postgres`, one-shot `migrate` and `seed` services, `orders-api` on port 3000, and `worker` with health on port 3001. The apps start after the seed completes. Compose health checks call `/readyz`, so "healthy" means the service can reach Postgres. An init script in `infra/postgres/init` creates the `commerce_test` database used by integration tests. M3 adds `otel-collector`, `jaeger` for traces, and `prometheus` for metrics. Logs stay JSON on stdout, with `trace_id` and `span_id` from M3. Exporting logs through the collector, and writing telemetry files, arrive with incident bundles in M5.

```
loadgen -> orders-api -> postgres <- worker
                 \           |         /
                  ---> otel-collector ---> jaeger, prometheus   (M3+; log export and files in M5)
```

## Order processing

Background work is the processing of an order, so the order row is the unit of work. There is no generic jobs table. ADR 0002 records why. The full M2 protocol is in `docs/prompts/m2-design.md` and ADR 0005.

1. The client places an order with `POST /orders`. The API inserts it as `pending` with its items and price snapshot. Stock is not checked at this point.
2. The worker claims only as many due orders as it has free slots (`WORKER_CONCURRENCY`) and starts each one at once. A claim increments `processing_attempts`, which is the pass's fencing token.
3. A charge pass reserves stock in one transaction, records the charge attempt, calls the simulator outside any transaction, and finalizes with a fenced update:
   - approved becomes `paid`;
   - declined becomes `failed`, with stock released;
   - an unknown outcome retries with backoff.
4. Once the charge budget is spent, passes only reconcile with `lookupOrVoid`. A recorded approval pays the order. A void fails it and releases stock. Lookup errors back off, then park the order in `payment_unknown` with its stock still reserved.
5. Expired claims and shutdown releases return orders to `pending`, or to `payment_unknown` if parked. Neither changes counters or stock.
6. From M3, the order stores its creating request's trace context. Each worker pass starts its own trace, linked to that context, so a request and every pass on its order can be found together without keeping one trace open for hours. See `docs/prompts/m3-design.md`.

Status transitions, enforced in code and by a trigger: `pending -> processing`, `payment_unknown -> processing`, and `processing -> paid | failed | pending | payment_unknown`.

## Extension points kept open in M1

- **Telemetry:** each app has a single entrypoint that builds everything through factories. M3 preloads OpenTelemetry with `node --import`, so Fastify and `pg` can be auto-instrumented without restructuring.
- **Logging:** both apps use pino through Fastify, so M3 adds `trace_id` and `span_id` through a pino mixin that reads the active span.
- **Resilience baseline:** the worker logs and retries database errors instead of crashing, and the pool handles idle-client errors. Outage incidents in M5 therefore show up as degraded behavior, not as crash loops.
- **Faults:** the pool, payment simulator, clock, and random source are injected. M5 can wrap them without touching call sites.
- **Determinism:** no hidden `Date.now()` or `Math.random()` in logic that affects order outcomes from M2 onward.

## Frontend readiness

A React UI is planned for M7, after the Engineering Operations AI UI exists. ADR 0004 records the decision. Until then, there is no frontend code, but the backend is built so a UI can be added without changing business logic.

- **Business rules stay in the backend.** Pricing, stock, and lifecycle rules live in the API and worker. The UI only displays state and submits requests.
- **Contracts are presentation-neutral.** Responses are JSON with stable field names, ISO 8601 timestamps, and integer cents. Any text a user sees is chosen by the UI, not returned by the API.
- **Errors are machine-readable.** Every error has the shape `{ error, message, details? }`, with a stable `error` code the UI can map to its own text.
- **Status is readable without guessing.** Order responses include the status, failure reason, and attempt count, so the UI can show progress by polling `GET /orders/:id`.
- **Lists are paginated with cursors,** so order history and catalog views scale.
- **Demo scenarios use the same API as everything else.** The M5 scenario control endpoints will list, start, and report on scenarios, and stay disabled unless `FAULTS_ENABLED=true`.
- **No UI concerns leak into the backend yet.** CORS, sessions, and static file serving are decided in M7.

## Fault scenarios

A scenario has a name, a seed, a start trigger, a duration, and a ground-truth description. Planned examples:

- Slow query from a missing index on a growing table.
- Connection pool exhaustion under load.
- Payment simulator timeouts and retry storms.
- Poison order that fails processing repeatedly and starves other orders.
- Stuck claims after a worker crash, leaving orders in `processing`.
- Payment provider lookup outage, parking orders in `payment_unknown` with stock held.
- Bad deploy simulated by a config flag that raises error rates on one endpoint.

Faults are enabled by environment variables, or by an admin endpoint that exists only when `FAULTS_ENABLED=true`.

## Incident bundle contract

The only interface with the agent repository. One directory per run:

```
incidents/<scenario>-<seed>-<timestamp>/
  manifest.json      # scenario, seed, time window, versions, schema version
  traces.jsonl       # OTLP JSON spans
  metrics.jsonl      # metric samples
  logs.jsonl         # structured logs
  ground_truth.json  # root cause, affected components, expected remediation
```

The bundle schema is versioned. Breaking changes require a new major version and an ADR.

## Boundaries and rules

- Apps depend on packages. Packages never depend on apps.
- Only the fault package decides whether a fault is active. Call sites ask it. They do not read environment variables directly.
- No component calls an external network service.
