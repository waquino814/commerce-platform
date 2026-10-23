# Roadmap

Each milestone is done only when every acceptance criterion passes on a clean clone.

## M0: Foundation (done)

- [x] Engineering rules, README, architecture, roadmap, and ADRs exist and agree with each other.
- [x] First commit made.

## M1: Skeleton, schema, and health (done)

Scope: pnpm workspace, `apps/orders-api`, `apps/worker`, `packages/db`, the `orders` table, health endpoints, Docker Compose, and CI. No commerce endpoints, telemetry export, load generation, or faults.

- [x] Install, format check, lint, typecheck, and tests pass from a clean copy of the working tree.
- [x] Migrations apply cleanly and a second run applies nothing.
- [x] `docker compose up --wait` brings every service to healthy within 120 seconds.
- [x] `/healthz` returns 200 while the process runs. `/readyz` returns 503 when Postgres is down and 200 again after it recovers.
- [x] Concurrent worker claims never claim the same order twice.
- [x] Both services exit with code 0 within 10 seconds of SIGTERM.
- [x] Invalid configuration makes a service exit with a non-zero code and a clear message.
- [x] The GitHub Actions workflow passes on the first push. The repository owner confirmed it after pushing the M1 commit.

Exact verification commands live in `docs/prompts/initial-implementation.md`.

## M2: Working commerce flow (verified locally; GitHub Actions run pending)

Scope and the 36 numbered acceptance criteria are in `docs/prompts/m2-design.md`. The processing protocol is recorded in ADR 0005. No UI, telemetry, load generation, or faults.

- [x] **Core flow, 1 to 16:**
  - catalog listing, and order creation, idempotency and retrieval;
  - payment outcomes and stock handling;
  - two workers over 200 mixed orders, stale claims, the transition trigger and constraints;
  - coverage of at least 80% per listed module, and the Compose end-to-end checks.
- [x] **Claim capacity, 17 to 19:** slot-based claiming, proven with event-synchronized tests rather than wall-clock thresholds, plus startup validation of the processing budget.
- [x] **Crash after approval, 20 to 22:** recovery reuses the recorded charge, with one ledger row and one reservation.
- [x] **Shutdown, 23 to 25 and 35:**
  - drain, and release of a charge recorded just before exit;
  - a stale worker fenced out after recovery;
  - a release blocked by a held row lock, which exits with code 1 and leaves the order recoverable.
- [x] **Lookup failures and `payment_unknown`, 26 to 31 and 36:** backoff, parking, rechecks, authoritative approval or void, racing workers, and stock released at most once.
- [x] **Ledger serialization and attempt semantics, 32 to 34:** both charge-versus-void orders, duplicate requests, and shutdowns not spending the payment budget.
- [ ] The GitHub Actions workflow passes with the M2 changes. Not yet observed. Mark this, and the milestone, done only after a green run.

Verification: `pnpm test:coverage` runs the deterministic criteria against the Compose Postgres. Criteria 1, 14, 15 and the informational timing check run against `docker compose up --build --wait`.

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
