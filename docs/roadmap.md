# Roadmap

Each milestone is done only when every acceptance criterion passes on a clean clone.

## Project order

The portfolio is built in this order, agreed in principle by the repository owner on 2026-10-25. The ADR text and the milestone mapping below still await approval:

1. **Commerce backend and infrastructure:** M0, M1 and M2.
2. **Observability and incidents:** M3, M4 and M5.
3. **Commerce Platform UI:** M7.
4. **Engineering Operations AI backend:** a new, independent Git repository. It reads incident bundles through the contract in ADR 0007 and shares no code with this repository.
5. **AI investigation UI:** in the Engineering Operations AI repository.

M6, portfolio polish, keeps its place after M5; the agreed order does not place it. Until M7, this repository ships no frontend, and its API contracts follow the rules in the "Frontend readiness" section of `docs/architecture.md`.

Proposed ADR 0008 records this order. Once accepted, it supersedes only the sequencing in ADR 0004, which built the Engineering Operations AI UI before the Commerce Platform UI. ADR 0004's API-first rules still apply.

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

## M2: Working commerce flow (done)

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
- [x] The GitHub Actions workflow passes with the M2 changes. The repository owner confirmed a green run for commit `3950841`.

Verification: `pnpm test:coverage` runs the deterministic criteria against the Compose Postgres. Criteria 1, 14, 15 and the informational timing check run against `docker compose up --build --wait`.

## M3: Observability (done)

The design and the 17 acceptance criteria are in `docs/prompts/m3-design.md`. Each part has its own commit and CI run. There is no log export through the collector, no telemetry files, and no UI. Those belong to M5 and M7.

### M3a: Telemetry foundation (done; GitHub Actions green for commit `9a73939`, confirmed by the repository owner)

- A one-day compatibility spike for automatic `pg` and `http` instrumentation under ESM import hooks, with the pinned package set. If it fails, explicit database spans in `packages/db`, the approved fallback.
- `packages/telemetry` exists, is off unless an OTLP endpoint is configured, and is used by both apps.
- HTTP and database spans. JSON logs on stdout carry `trace_id` and `span_id` only inside an active span.
- The collector, Jaeger and Prometheus run in Compose at pinned versions, and their health endpoints answer.

### M3b: Order trace correlation (done; GitHub Actions green for commit `8a0a941`, confirmed by the repository owner)

- Order creation stores its trace context. Every worker pass starts a new trace whose root span links to the order's creation trace. No trace stays open across retries, reconciliation, or `payment_unknown` rechecks.
- Searching Jaeger by `order.id` finds the creation trace and every pass trace within 10 seconds.
- Concurrent passes never share trace context.

### M3c: Metrics (done; GitHub Actions green for commit `8a0a941`, confirmed by the repository owner)

- Request rate, error rate, latency histograms, orders by status, connection pool usage, and worker and payment counters are visible in Prometheus.
- Labels are low cardinality, with no order ids or SKUs.
- Order counts come from a dedicated one-connection metrics pool. Metric failures never affect order processing.
- Live Compose checks for criteria 15 and 16 last ran before the final hardening pass and have not been rerun.

### Across M3

- Telemetry failures, including a stopped collector, never change order outcomes or health.
- M2 behavior, tests and shutdown contract stay intact. The telemetry flush at shutdown is best effort and capped at 300 ms.

## M4: Load generation (done; GitHub Actions green for commit `5f6f6eb`, confirmed by the repository owner)

The design and the 12 acceptance criteria are in `docs/prompts/m4-design.md`, with ADR 0006. All 12 criteria pass.

- `pnpm loadgen --profile steady --seed 42` produces the same request sequence on every run.
- The steady profile sustains at least 50 requests per second locally with p95 latency under 200 ms and error rate under 1%.

**Criterion 11, the local performance check,** ran once on 2026-10-25 (UTC), with the repository owner's approval, against the Compose stack after `docker compose up -d --build --wait`. `pnpm loadgen --profile steady --seed 42 --json` passed its preflight, ran, and exited 0. The `--json` flag changes only the report format, not the plan or the run.

- **Load-generator measurements,** over the 60 s window: 3,300 entries offered, 3,300 sent and successful, and none failed, missed or skipped. Throughput 55.00 rps, p95 latency 8.2 ms, failure rate 0%. These are the measurements the thresholds apply to.
- **Plan:** the plan hash matched the committed golden value.
- **Post-run checks:** the database holds 923 orders with the run's idempotency prefix, every create in the plan, with no duplicate keys. The worker drained its backlog completely: no orders were left pending, processing or in `payment_unknown`.
- **Prometheus, informational only:** the orders API's own server-side p95 over the run was about 6 ms. It is measured inside the API, not by the load generator, and is not used for the thresholds.

## M5: Fault scenarios and incident bundles (active: M5a and M5b committed, CI not yet confirmed; M5c implemented, live runs need approval)

The design and its acceptance criteria are in `docs/prompts/m5-design.md`, with ADR 0007 for bundle schema version 1. The repository owner approved M5a and ADR 0007 on 2026-10-25, and M5b's contract addendum and implementation the same day. M5a is committed in `d1579ec`; its GitHub Actions result is not yet confirmed. M5b is committed; its GitHub Actions result is not yet confirmed. The owner approved M5c's implementation on 2026-10-25, against `docs/prompts/m5c-design.md`. It is committed; its GitHub Actions result is not yet confirmed. Container integration verified that design's open runtime items 1 to 3 on 2026-10-25. The stack runs with `compose.faults.yaml`, the API, worker, Jaeger and Prometheus bound to loopback, from an image that includes M5a, and the CLI's isolation checks pass. Trace volume and Jaeger capture time are unverified; `capture-check` against the stack and every live run need separate approval.

- At least five scenarios from the architecture document are implemented.
- Each scenario is off by default, verified by a test.
- Running a scenario twice with the same seed produces identical ground truth, the same set of affected components, and the same primary symptom.
- Each scenario's primary symptom is visible in exported telemetry within 2 minutes of the trigger.
- Bundles validate against the versioned schema.

## M6: Portfolio polish

- README includes a quick start that takes under 10 minutes on a fresh machine.
- A small sample incident bundle is committed under `docs/examples/`, with a walkthrough of its signals.
- Architecture diagram and ADRs are current.

## M7: Commerce UI

Starts after the observability and incidents phase, M3 to M5, is complete. See "Project order".

- `apps/web` is a React app that runs locally through Docker Compose, with no cloud services.
- Users can place an order, see order history, and watch an order's status change until it is `paid` or `failed`.
- Users can list and start predefined demo scenarios through the M5 scenario endpoints, which are enabled only in demo mode.
- The UI uses only the public HTTP API. No pricing, stock, or lifecycle rule is reimplemented in the UI.
- Any endpoint the UI needs that does not exist yet, such as order history listing, is added to the API with tests first.
- End-to-end tests cover placing an order and seeing it reach a terminal status.
