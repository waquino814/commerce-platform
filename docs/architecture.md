# Architecture

## Goal

Run a believable commerce workload locally, inject faults on demand, and export what an on-call engineer would see, plus the ground truth of what actually broke.

## Components

Each component appears only in the milestone that gives it real code.

| Component            | Milestone | Responsibility                                                                           | Does not                                                |
| -------------------- | --------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `apps/orders-api`    | M1        | Fastify HTTP API for catalog and orders. Writes orders as `pending`.                     | Process orders inline.                                  |
| `apps/worker`        | M1        | Claims `pending` orders and processes them: inventory reservation and simulated payment. | Serve public traffic. It exposes health endpoints only. |
| `packages/db`        | M1        | SQL migrations, migration runner, connection pool factory, data-access functions.        | Contain business rules.                                 |
| `apps/loadgen`       | M4        | Seeded, deterministic traffic profiles against the orders API.                           | Inspect internal state.                                 |
| `packages/telemetry` | M3        | OpenTelemetry SDK setup and shared metric names for both apps.                           | Know about business logic.                              |
| fault package        | M5        | Scenario registry and injection hooks. Inert unless enabled.                             | Change behavior by default.                             |
| incident tool        | M5        | Runs a scenario end to end and writes an incident bundle.                                | Analyze or diagnose incidents.                          |

Pure order and pricing rules start inside the app that uses them. They move to a shared package only if a second consumer appears.

## Runtime topology

M1 Compose services: `postgres`, a one-shot `migrate`, `orders-api` on port 3000, and `worker` with health on port 3001. Compose health checks call `/readyz`, so "healthy" means the service can reach Postgres. An init script in `infra/postgres/init` creates the `commerce_test` database used by integration tests. M3 adds `otel-collector`, `jaeger` for traces, and `prometheus` for metrics. Logs are JSON on stdout from M1 and are also exported through the collector from M3.

```
loadgen -> orders-api -> postgres <- worker
                 \           |         /
                  ---> otel-collector ---> jaeger, prometheus, log files   (M3+)
```

## Order processing

Background work is the processing of an order, so the order row is the unit of work. There is no generic jobs table. ADR 0002 records why.

1. The client places an order. The orders API inserts it with status `pending`.
2. The worker claims a batch with `UPDATE orders ... WHERE id IN (SELECT ... WHERE status = 'pending' FOR UPDATE SKIP LOCKED)`. Each claim sets `status = 'processing'`, `claimed_by`, `claimed_at`, and increments `processing_attempts`.
3. From M2, the worker reserves inventory, calls the payment simulator, and moves the order to `paid` or `failed`, recording `last_error` on failure.
4. From M2, claims older than a timeout are returned to `pending`. Orders past a maximum attempt count are marked `failed`.
5. From M3, trace context is stored with the order so one trace spans the API request and the worker's processing.

Status transitions: `pending -> processing -> paid | failed`, plus `processing -> pending` on stale claim recovery.

## Extension points kept open in M1

- **Telemetry:** each app has a single entrypoint that builds everything through factories. M3 preloads OpenTelemetry with `node --import`, so Fastify and `pg` can be auto-instrumented without restructuring.
- **Logging:** both apps use pino through Fastify, so M3 only adds a `trace_id` field.
- **Resilience baseline:** the worker logs and retries database errors instead of crashing, and the pool handles idle-client errors. Outage incidents in M5 therefore show up as degraded behavior, not as crash loops.
- **Faults:** the pool, payment simulator, clock, and random source are injected. M5 can wrap them without touching call sites.
- **Determinism:** no hidden `Date.now()` or `Math.random()` in logic that affects order outcomes from M2 onward.

## Fault scenarios

A scenario has a name, a seed, a start trigger, a duration, and a ground-truth description. Planned examples:

- Slow query from a missing index on a growing table.
- Connection pool exhaustion under load.
- Payment simulator timeouts and retry storms.
- Poison order that fails processing repeatedly and starves other orders.
- Stuck claims after a worker crash, leaving orders in `processing`.
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
