# Roadmap

Each milestone is done only when every acceptance criterion passes on a clean clone.

## M0: Foundation (current)
- [x] Engineering rules, README, architecture, roadmap, and ADRs exist and agree with each other.
- [ ] First commit made.

## M1: Skeleton, schema, and health
Scope: pnpm workspace, `apps/orders-api`, `apps/worker`, `packages/db`, the `orders` table, health endpoints, Docker Compose, and CI. No commerce endpoints, telemetry export, load generation, or faults.
- Install, format check, lint, typecheck, and tests pass from a clean clone.
- Migrations apply cleanly and a second run applies nothing.
- `docker compose up --wait` brings every service to healthy within 120 seconds.
- `/healthz` returns 200 while the process runs. `/readyz` returns 503 when Postgres is down and 200 again after it recovers.
- Concurrent worker claims never claim the same order twice.
- Both services exit with code 0 within 10 seconds of SIGTERM.
- Invalid configuration makes a service exit with a non-zero code and a clear message.
- The GitHub Actions workflow passes on the first push.

Exact verification commands live in `docs/prompts/initial-implementation.md`.

## M2: Commerce core
- Endpoints exist for listing products, placing an order, and fetching an order.
- The worker reserves inventory and calls the payment simulator, moving orders to `paid` or `failed`.
- Stale claims return to `pending`. Orders past the attempt limit become `failed`. Both are covered by tests.
- Seed data creates at least 1,000 products deterministically.
- Line coverage is at least 80% for order and pricing logic. Integration tests cover the full order lifecycle against Postgres.

## M3: Observability
- `packages/telemetry` exists and is used by both apps.
- One trace links the HTTP request, its database queries, and the worker's processing of that order.
- Request rate, error rate, latency histograms, pending order count, and pool usage are visible in Prometheus.
- Every log line includes `trace_id` when one exists.
- Traces appear in Jaeger within 10 seconds of the request.

## M4: Load generation
- `pnpm loadgen --profile steady --seed 42` produces the same request sequence on every run.
- The steady profile sustains at least 50 requests per second locally with p95 latency under 200 ms and error rate under 1%.

## M5: Fault scenarios and incident bundles
- At least five scenarios from the architecture document are implemented.
- Each scenario is off by default, verified by a test.
- Running a scenario twice with the same seed produces identical ground truth, the same set of affected components, and the same primary symptom.
- Each scenario's primary symptom is visible in exported telemetry within 2 minutes of the trigger.
- Bundles validate against the versioned schema.

## M6: Portfolio polish
- README includes a quick start that takes under 10 minutes on a fresh machine.
- A small sample incident bundle is committed under `docs/examples/`, with a walkthrough of its signals.
- Architecture diagram and ADRs are current.
