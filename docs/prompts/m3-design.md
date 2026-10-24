# M3 design: observability

Status: design approved. The M3a spike is complete; see "Spike outcome". **M3a is implemented and verified locally, pending review and the GitHub Actions run.** **M3b is implemented and verified locally, pending review and the GitHub Actions run.** M3c has not started.

## Scope

**In scope:**

- a `packages/telemetry` package used by both apps;
- traces for HTTP requests, database queries, order creation, and every worker pass;
- trace-correlated JSON logs on stdout;
- metrics for HTTP, connection pools, order status counts, and worker and payment activity;
- an OpenTelemetry Collector, Jaeger and Prometheus in Docker Compose;
- one additive migration that stores the order-creation trace context.

**Out of scope:**

- exporting logs through the collector, and telemetry files. Both move to M5, with incident bundles;
- load generation (M4), fault injection and bundles (M5), and any UI (M7);
- dashboards and alerting;
- any change to order outcomes, API responses, the lifecycle, or M2's shutdown contract.

M3 ships in three parts, each with its own commit and CI run:

| Part    | Delivers                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M3a** | Compatibility spike, then the telemetry package, SDK bootstrap and config, HTTP and database spans, the log mixin, and the collector, Jaeger and Prometheus services. |
| **M3b** | Migration 003, which stores the creation trace context, plus per-pass worker traces linked to it, provider spans, and recovery and release spans.                     |
| **M3c** | The metric catalog below, the dedicated metrics pool and order-status sampler, and the Prometheus scrape.                                                             |

## Architecture and data flow

```
orders-api ──OTLP/HTTP──┐                        ┌──> jaeger      (traces, UI :16686)
                        ├──> otel-collector ─────┤
worker ─────OTLP/HTTP───┘    :4318, health :13133 └──> :8889 <── prometheus scrape (:9090)

stdout: JSON logs from both apps, with trace_id and span_id inside a span
```

- Both apps build the SDK programmatically in `packages/telemetry`. Nothing is configured implicitly from `OTEL_*` environment variables beyond what the Zod config below reads.
- Traces use a batch span processor with a 1 s schedule delay. Metrics use a periodic reader that exports every 5 s with a 3 s timeout. Both export OTLP over HTTP with protobuf encoding, so no gRPC native modules are needed.
- The collector runs the `memory_limiter` and `batch` processors, with a 200 ms batch timeout.
  - It sends traces to Jaeger with the `otlp_grpc` exporter, configured as `otlp_grpc/jaeger` with endpoint `jaeger:4317` and insecure TLS. Collector 0.162.0 warns that the older `otlp` name is a deprecated alias, so it is not used.
  - It exposes metrics through its `prometheus` exporter on `0.0.0.0:8889`.
- **Prometheus** scrapes the collector every 5 s, with `honor_labels: true` on that scrape job, so the collector's `job` and `instance` labels are kept. See "Metrics".
- Sampling is always-on, because the system runs locally at low volume.

### Trace correlation model

A worker pass never joins the request's trace. Each pass starts a new trace and links back to the order's creation trace. No trace stays open across retries, reconciliation, or hours of `payment_unknown` rechecks.

| Where            | Span                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /orders`   | The HTTP server span, plus an `order.create` child. Once the order exists, both carry `order.id`, and `order.create` also carries `order.idempotent_replay`. Database spans are children. The W3C `traceparent` of `order.create` is stored in `orders.trace_context` when the order is inserted. A replay does not overwrite it.                                                                                                                                                |
| Each worker pass | A new root span, `order.process`, with kind CONSUMER. It links to the stored creation context, with link attributes `order.link = "created"` and `order.id`.                                                                                                                                                                                                                                                                                                                     |
| Pass attributes  | `order.id`, `order.pass.type` (`charge` or `reconciliation`), `order.processing_attempt` (the token), `order.charge_attempts`, `order.reconciliation_attempts`, and, at the end, `order.pass.outcome`.                                                                                                                                                                                                                                                                           |
| Pass children    | `order.reserve`, then `payment.charge` or `payment.lookup_or_void` with `payment.result` and `payment.replayed`, then `order.finalize` with `order.finalize.target` and `order.inventory_released`. `order.inventory_released` is true exactly when a finalize to `failed` released reserved stock. Database spans sit under the step that issued them.                                                                                                                          |
| Status           | ERROR only for the `error` and `aborted` outcomes. An unknown payment outcome is recorded as a span event `payment.outcome_unknown`, not as an error.                                                                                                                                                                                                                                                                                                                            |
| Claim recovery   | A root span `worker.recover_claims`, emitted only when a sweep recovered at least one order. Its start time is taken before the statement ran, and it carries `claims.recovered`. It has **one child span per recovered order**, `order.claim_recovered`, carrying `order.id`, `order.status` (the target status) and `order.processing_attempt`. Each child links to that order's creation context, with link attribute `order.id`. Sweeps that recover nothing create no span. |
| Shutdown release | A root span `worker.release_claims` with `release.released` and `release.unconfirmed`, and one child per affected order, `order.claim_released`, with `order.id` and `release.result` (`released` or `unconfirmed`). Each child links to the creation context, as for recovery.                                                                                                                                                                                                  |
| Missing context  | Orders created before M3, or while telemetry was off, have no `trace_context`. Their pass span, or their recovery or release child span, has no link and sets `order.trace_context_missing = true`. Processing is unchanged.                                                                                                                                                                                                                                                     |

Why there is one child span per affected order, and not one span with many links:

- **No link cap.** The SDK caps links per span at 128 by default and silently drops the rest. A sweep after a mass crash could exceed that. One link per child never hits the cap.
- **Searchable.** Each order gets its own `order.id` attribute, which tag search can match.
- **Per-order logs.** Each order gets its own log line inside its own span context.

The number of children is bounded by the number of orders in `processing`, which is at most the sum of all workers' `WORKER_CONCURRENCY`.

**Log correlation for recovery and release:** the sweep logs one `claim_recovered` or `claim_released` line per order, inside that order's child span. Each line has the sweep's `trace_id` and the child's `span_id`, plus `orderId` as a log field. A line logged outside these spans, such as the loop's own errors, has no trace fields.

**Context isolation:** each pass runs inside `context.with(trace.setSpan(ROOT_CONTEXT, passSpan), ...)`. The loop's claim, recovery and dispatch code runs outside any pass context, so one order's context can never parent another order's spans or logs.

**Polling:** claim and poll iterations are not traced, so idle polling doesn't produce one span per second. The recovery statement itself has no database span, because the sweep span is only created once there is a result to report.

### Trace search

Jaeger 2.22.0 serves trace search only through its v3 API, `GET /api/v3/traces`. The older `/api/traces` path keeps only lookup by trace id, `/api/traces/{traceID}`. This was verified in the v2.22.0 source of the query extension.

- `query.serviceName` is optional, so a single search covers both services. Jaeger's in-memory store matches a query attribute against span attributes, scope and resource attributes, span event attributes, and link attributes.
- **`query.startTimeMin` and `query.startTimeMax` are required** and are always supplied as RFC 3339 timestamps. Without both, Jaeger 2.22.0 rejects the search with HTTP 400, "invalid query: min and max start time are required". The spike observed this on the running image.
- `query.searchDepth` is optional: with a time window and no depth, the spike's search returned HTTP 200. The implementation may set it to bound result size, but no criterion depends on it.

The search for one order, with a window that covers the order's lifetime, for example from 10 minutes before creation to 1 minute in the future:

```
GET /api/v3/traces?query.attributes={"order.id":"<id>"}
    &query.startTimeMin=<RFC 3339>&query.startTimeMax=<RFC 3339>
```

It returns the creation trace, every pass trace, and any recovery or release trace that touched the order. Each pass root also carries a link whose trace id is the creation trace, so `GET /api/v3/traces/{traceID}` can follow a pass back to its creation trace.

**What spans never record:**

- SQL parameter values;
- payment references, which stay in the `payment_charges` ledger and in M2's `order_paid` log line;
- payment method tokens.

Order ids appear only as span, link and log attributes, never as metric labels.

**Expected latency:** spans are exported after at most a 1 s batch delay, the collector's batch processor waits at most 200 ms, and Jaeger's in-memory store indexes them immediately. That is about 2 s against the 10 s criterion.

### Database spans

1. **M3a spike, timeboxed to one working day.** The goal is automatic `pg` and `http` instrumentation in the ESM apps on Node 24, through an `--import` entrypoint that registers `@opentelemetry/instrumentation/hook.mjs` before the apps load. The file ships in the pinned instrumentation package; it was checked in the published file listing.
   - **Exit criteria:** under the production Docker image with the pinned package set, an ESM process that uses `import pg from 'pg'` records `pg` query spans and HTTP server spans with correct parents.
   - It must also show no duplicate `@opentelemetry/core` or instrumentation versions in `pnpm why`, no hook warnings at startup, and no unhandled rejection when the endpoint is unreachable.
2. **`pg` instrumentation settings:**
   - `requireParentSpan: true`, so poll, claim, recovery and readiness queries outside a span create no spans;
   - `enhancedDatabaseReporting: false`, so parameter values are never recorded, only the parameterized statement.
3. **Approved fallback, not needed.** Automatic instrumentation passed the spike, so these explicit spans inside `packages/db` are **not implemented** in M3a. They stay documented in case a later upgrade breaks the import hook.
   - Every data-access function wraps its work in a span named `db.<function>`, for example `db.claimDueOrders` or `db.reserveInventory`. The span is only created when a span is already active, matching `requireParentSpan`.
   - Attributes: `db.system.name = "postgresql"`, `db.operation.name`, and `db.collection.name` where obvious.
   - No statement parameters are recorded.
   - `packages/db` then depends on `@opentelemetry/api` only, which is a no-op without an SDK.
4. **Chosen path:** automatic `pg` and `http` instrumentation. The spike evidence is in "Spike outcome".
5. **Preload import graph,** found during M3a. Static imports run before the preload's body, so nothing the preload imports may load `pg` before the ESM hook is registered. Otherwise `pg` is never patched.
   - `packages/telemetry` therefore imports only `@commerce/db/config`, a zod-only subpath, never the `@commerce/db` root entry, which loads `pg`.
   - A unit test, `packages/telemetry/test/imports.test.ts`, enforces this.
   - The smoke test proves `pg` spans appear under the production preload.

HTTP server spans come from `@opentelemetry/instrumentation-http`. A Fastify `onRequest` hook renames the active server span to `<METHOD> <route template>` and sets `http.route`, so `@fastify/otel` is not needed. Health probes, `/healthz` and `/readyz`, are excluded through the instrumentation's incoming-request ignore hook.

### Trace-correlated logs

- A pino `mixin` reads `trace.getActiveSpan()`. When the span context is valid, it adds `trace_id` and `span_id`. Outside an active span, neither field appears.
- There is no pino auto-instrumentation and no monkeypatching.
- Logs stay JSON on stdout. They are not exported through the collector in M3.

## Metrics

Label values always come from closed sets. Order ids, SKUs, raw URLs, payment references and error messages are never labels; they belong on spans and logs.

**Label rules:**

- `http.route` is Fastify's route template, `request.routeOptions.url`, such as `/orders/:id`, never `request.url`. It is omitted for unmatched routes, such as 404s.
- `http.request.method` is one of `GET`, `POST`, `HEAD` or `OPTIONS`. Any other method becomes `_OTHER`, following the semantic conventions.
- `http.response.status_code` is the numeric status.
- `commerce.orders` always reports all five statuses, with 0 for statuses that have no orders. The set of series is therefore fixed.
- Histograms use explicit buckets, so bucket labels are fixed: 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5 and 10 s.

| Instrument                              | Kind                       | Unit           | Labels and their closed value sets                                                                                                                   | Expected Prometheus name                                  |
| --------------------------------------- | -------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `http.server.request.duration`          | histogram                  | s              | `http.request.method` (5 values), `http.route` (3 templates, or absent), `http.response.status_code`                                                 | `http_server_request_duration_seconds_{bucket,count,sum}` |
| `db.client.connection.count`            | observable up-down counter | `{connection}` | `db.client.connection.pool.name` (`orders-api`, `worker`, `simulator`, `metrics`), `db.client.connection.state` (`idle`, `used`)                     | `db_client_connection_count`                              |
| `db.client.connection.pending_requests` | observable up-down counter | `{request}`    | `db.client.connection.pool.name`                                                                                                                     | `db_client_connection_pending_requests`                   |
| `db.client.connection.max`              | observable up-down counter | `{connection}` | `db.client.connection.pool.name`                                                                                                                     | `db_client_connection_max`                                |
| `commerce.orders`                       | observable gauge           | `{order}`      | `order.status` (5 values)                                                                                                                            | `commerce_orders`                                         |
| `commerce.worker.passes`                | counter                    | `{pass}`       | `order.pass.type` (2 values), `order.pass.outcome` (8 values)                                                                                        | `commerce_worker_passes_total`                            |
| `commerce.worker.inflight`              | observable gauge           | `{pass}`       | none                                                                                                                                                 | `commerce_worker_inflight`                                |
| `commerce.payment.calls`                | counter                    | `{call}`       | `payment.operation` (`charge`, `lookup_or_void`), `payment.result` (`approved`, `declined`, `voided`, `error`), `payment.replayed` (`true`, `false`) | `commerce_payment_calls_total`                            |
| `commerce.payment.duration`             | histogram                  | s              | `payment.operation`, `payment.result`                                                                                                                | `commerce_payment_duration_seconds_{bucket,count,sum}`    |
| `commerce.claims.recovered`             | counter                    | `{order}`      | `order.status` (`pending` or `payment_unknown` target)                                                                                               | `commerce_claims_recovered_total`                         |
| `commerce.claims.released`              | counter                    | `{order}`      | `release.result` (`released`, `unconfirmed`)                                                                                                         | `commerce_claims_released_total`                          |

The Prometheus names follow the collector exporter's default translation: dots become underscores, `s` becomes a `_seconds` suffix, curly-brace units are dropped, and counters gain `_total`. Label keys likewise become `order_status`, `http_route` and so on. The spike confirmed all 11 names, exactly as listed, against collector 0.162.0 and Prometheus v3.15.0. Criterion 15 uses them.

**Resource attributes:**

- `service.name`;
- `service.version`;
- `service.instance.id`, which is `WORKER_ID` for the worker and `OTEL_SERVICE_INSTANCE_ID`, defaulting to the hostname, for the API;
- `deployment.environment.name = "local"`.

The collector's exporter maps `service.name` to the `job` label and `service.instance.id` to `instance`. Other resource attributes go only to `target_info`, so they never multiply series.

**`honor_labels: true` is required** on the Prometheus scrape job. Without it, Prometheus's own scrape labels win, and the series show up as `job="otel-collector"` and `instance="otel-collector:8889"`, with the real values moved to `exported_job` and `exported_instance`. The spike observed both behaviors on Prometheus v3.15.0. With it, the series carry, for example, `job="worker"` and `instance="worker-1"`.

`commerce.orders` is global state, so every worker reports the same counts. Query it with `max by (order_status) (commerce_orders)`, not `sum`.

### Order-status sampler and the metrics pool

- The worker gets a dedicated pool with `max: 1`, a 1 s connection timeout, and `statement_timeout = 1000`. It never uses the worker pool or the simulator pool, so M2's slot budget of `WORKER_CONCURRENCY + 2` is unchanged.
- A timer every `METRICS_SAMPLE_INTERVAL_MS`, default 5000, runs `SELECT status, count(*) FROM orders GROUP BY status`. Only one sample runs at a time: if the previous one is still running, the tick is skipped. The result is cached.
- The gauge callback reads only the cache and never queries the database. A cached sample older than three intervals is treated as missing, so the gauge reports nothing instead of stale counts.
- A failure, whether timeout, database down or pool error, is logged at `debug` level and skipped. It is never thrown, retried in a loop, or allowed to affect the processing loop.
- When telemetry is disabled, the sampler and the metrics pool are not created.

## Failure isolation

- **Off by default.** Telemetry is disabled unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. When disabled, no SDK starts, the `@opentelemetry/api` calls are no-ops, and no network calls are made. Tests and `pnpm dev` therefore behave exactly as in M2, unless telemetry is enabled explicitly.
- **Nothing waits on export.** Processing and request paths never await an export. Span ending, metric recording and log mixing are synchronous and in memory.
- **Exporter failures** stay inside the batch processor and periodic reader. In the spike, refused and hanging endpoints produced no unhandled rejections and no uncaught exceptions, and no change in request latency or success. Failures surfaced only through OpenTelemetry's diagnostic logger, which produced 7 to 12 error messages in 8 s.
- **Diagnostic rate limiting.** OpenTelemetry's diagnostic logger is routed to pino at `warn` through a rate limiter:
  - at most one line per message kind per 60 s, where the kind is the message with numbers, ports and ids stripped;
  - each emitted line carries `suppressed`, the number of messages of that kind dropped since the previous line;
  - the limiter's clock is injectable, so it can be tested with a fake clock.

  A long collector outage therefore produces about one line per minute per kind, never a flood.

- **Diagnostic wiring.** Rate limiting only helps if every OpenTelemetry component reports through the logger we install. The wiring:
  - **One API copy.** All SDK, exporter and instrumentation packages share the single `@opentelemetry/api` 1.9.1 in the lockfile; the spike confirmed it resolves to one version. `diag` is a process-wide global on that API, so every package reaches the same logger. A test reads `pnpm-lock.yaml` and fails if more than one `@opentelemetry/api` version appears.
  - **Installed first.** The preload entrypoint calls `diag.setLogger(rateLimitedLogger, DiagLogLevel.WARN)` before it constructs any exporter, processor, reader or instrumentation. Instrumentations log through `diag.createComponentLogger`, which forwards to the global logger at call time, so they are covered as well.
  - **Export failures.** The batch span processor and the periodic metric reader report export failures through `@opentelemetry/core`'s global error handler. Its default writes to `diag.error`, and the spike confirmed refused and hanging endpoints arrived through the installed `diag` logger, 12 and 7 messages. The preload also calls `setGlobalErrorHandler` explicitly, sending errors to the same rate-limited logger, so the path doesn't depend on that default.
  - **One output.** Lines from the rate-limited logger are JSON on stdout with `otel_diag: true`, `kind` and `suppressed`. Nothing from OpenTelemetry is written to stderr or `console`.
  - **End-to-end test,** run under the production preload, as part of criterion 16:
    - with an endpoint whose connections are refused, it waits for the event "rate-limited logger received an export error" rather than a fixed time;
    - it asserts that at least one trace-export error arrived through the logger with `otel_diag: true`, and that stderr is empty;
    - this proves the real wiring, not just the limiter in isolation.

- **Bounded memory.** The batch span processor queue is capped at 2048 spans and drops the excess. Telemetry loss is acceptable; blocking is not.
- **Telemetry config errors** fail startup with exit code 1 and name the variable, like every other config error.
- **The collector being down** never changes an order outcome, a response, a status transition, or health and readiness results.

## Configuration

These are read and validated with Zod in `packages/telemetry`:

| Variable                      | Default                              | Meaning                                                                                    |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset, so telemetry is disabled      | Collector base URL, for example `http://otel-collector:4318`.                              |
| `OTEL_SDK_DISABLED`           | `false`                              | `true` disables telemetry even when an endpoint is set.                                    |
| `OTEL_SERVICE_NAME`           | `orders-api` or `worker`             | Resource `service.name`.                                                                   |
| `OTEL_METRIC_EXPORT_INTERVAL` | 5000                                 | Metric export interval in ms. Minimum 1000. Must be at least `OTEL_METRIC_EXPORT_TIMEOUT`. |
| `OTEL_METRIC_EXPORT_TIMEOUT`  | 3000                                 | Metric export timeout in ms. Minimum 500. Must not exceed the interval.                    |
| `OTEL_BSP_SCHEDULE_DELAY`     | 1000                                 | Span batch delay in ms. Minimum 100.                                                       |
| `METRICS_SAMPLE_INTERVAL_MS`  | 5000                                 | Worker order-status sampler interval. Minimum 1000.                                        |
| `OTEL_SERVICE_INSTANCE_ID`    | `WORKER_ID` (worker), hostname (API) | Resource `service.instance.id`.                                                            |
| `OTEL_EXPORTER_OTLP_TIMEOUT`  | 3000                                 | Per-export timeout in ms, which bounds in-flight requests. Minimum 500.                    |

Compose sets the endpoint for both apps. `.env.example` documents all nine variables, with the endpoint commented out.

**Cross-field validation:** `OTEL_METRIC_EXPORT_INTERVAL >= OTEL_METRIC_EXPORT_TIMEOUT`. The SDK's periodic metric reader throws at construction, with "exportIntervalMillis must be greater than or equal to exportTimeoutMillis", when this is violated. The spike hit that error. The Zod config rejects the combination first, with a `ConfigError` naming both variables. Exporter URLs are also validated before any exporter is constructed, because the OTLP exporter throws synchronously on a malformed URL; the spike observed that as well.

## Shutdown

M2's contract is unchanged: a 7 s drain, then abort and release, then exit with the code M2 defines, with the 8 s hard deadline still forcing exit code 1. `shutdownWorker` and its tests are not modified. Telemetry only adds one best-effort step after M2's cleanup in `main.ts`, and never changes the exit code.

**Worker:**

| Time             | Step                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| T0               | SIGTERM. The hard timer is armed for T0 + 8 s, as in M2. The order-status sampler timer stops.                               |
| T0 to T0 + 7 s   | M2 drain, inside `shutdownWorker`.                                                                                           |
| at most T0 + 7 s | M2 abort and release. The release spans and `commerce.claims.released` are recorded in memory here.                          |
| then             | M2 cleanup: health close, worker pool end, simulator pool end capped at 300 ms. Then the metrics pool end, capped at 100 ms. |
| then             | `flushWithinBudget`, described below.                                                                                        |
| exit             | `process.exit(code)`, with the code from M2's shutdown result.                                                               |

**How a hanging exporter is kept from extending shutdown.** `flushWithinBudget({ flush, capMs: 300, deadlineAt, now })`, in `packages/telemetry`, works like this:

1. It computes `budget = min(300, deadlineAt − now() − 100)`. If `budget < 50` it returns `skipped` without calling `flush`.
2. Otherwise it calls `flush()`, which runs `forceFlush` on the span processor and the metric reader, and races it against a timer of `budget` ms. It returns `flushed`, `failed` or `timed_out`. It never throws.
3. A `.catch` handler is attached to the flush promise before the race. A late rejection is therefore never an unhandled rejection, which on Node 24 would crash the process with exit code 1 and change M2's result.
4. After the race, the providers' `shutdown()` is started but not awaited, again with a `.catch` attached.

**The underlying export can stay pending after the timeout.** An OTLP HTTP request already in flight is not cancelled by the race. It keeps its socket and the exporter's own timeout, which is set to 3 s so that pending work stays bounded during normal running. Nothing awaits it: `main.ts` calls `process.exit` straight after `flushWithinBudget` returns, which ends the process with the request still pending and the data dropped. Telemetry loss at shutdown is accepted. A delayed exit is not.

**Why telemetry cannot hold up order processing:**

- During processing, span end, metric recording and the log mixin are synchronous, in-memory operations. Export happens on the batch processor's and reader's own timers, and no order code awaits it.
- When the batch queue is full, spans are dropped; nothing blocks.
- During shutdown, the flush runs only after `shutdownWorker` has resolved, so it can't delay the drain, the abort or the release.

The worst case stays bounded by the M2 hard deadline: telemetry adds at most 300 ms, and never past T0 + 7.9 s. The usual case is a drain under 1 s, then a flush of at most 300 ms.

**Orders API:** SIGTERM, then `app.close()`, then pool end, then `flushWithinBudget` against the API's own 8 s hard deadline, then exit 0.

**Deterministic tests for shutdown isolation.** These are new test files. The M2 shutdown tests stay unchanged.

1. **`flushWithinBudget` unit test,** with fake timers and an `unhandledRejection` listener:
   - a never-settling flush stays pending at 299 ms and returns `timed_out` at 300 ms;
   - a rejecting flush returns `failed`;
   - a resolving flush returns `flushed`;
   - `deadlineAt − now() < 150` returns `skipped` without calling `flush`;
   - the budget shrinks to `deadlineAt − now() − 100` near the deadline;
   - no unhandled rejection is ever emitted, even when the flush rejects after the timeout.
2. **Shutdown orchestration unit test.** The final shutdown step in `main.ts` is extracted into an orchestrator with injectable steps, clock and `exit`. With a never-settling flush, `exit` is called exactly once, with the code from the shutdown result. The calls happen in the order shutdown, cleanup, flush, exit. The flush is never started before the shutdown result exists.
3. **Hanging-exporter integration test.** M2 criteria 23, 24 and 35 are re-run with a test SDK installed whose span exporter and metric exporter never settle.
   - `shutdownWorker` returns exactly the M2 results: `{ exitCode: 0, drained: true }`, the release result, and `{ exitCode: 1, unconfirmed: [id] }`.
   - Pass outcomes match M2's.
   - This proves a hung exporter can neither hold an order pass nor the shutdown protocol.

## Compatibility

- **Migration 003, `003_order_trace_context.sql`:** adds `orders.trace_context text NULL`, with a check against the W3C `traceparent` format `^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$`.
  - It is additive, with no backfill.
  - The transition trigger fires only on `UPDATE OF status`, so it is unaffected.
  - The M2 constraints are unaffected.
- **Data access:** `createOrder` accepts an optional `traceContext`, and `claimDueOrders` also returns `trace_context`.
  - **Recovery, as built in M3b:** `recoverExpiredClaims` keeps its exact M2 return shape, `{ id, status }`, because M2 tests assert it with exact equality. A new `recoverExpiredClaimsWithContext` runs the same statement and also returns `processing_attempts` and `trace_context`. The worker's traced recovery uses it.
  - **Release:** the shutdown release reads each order's context from the in-memory pass registry through an optional lookup passed to `createClaimReleaser`, so it needs no extra query. `shutdownWorker` is unchanged.
- **Logging:** recovery logs one line per recovered order instead of one line listing the ids. This is a log-format change only. No M2 test asserts the old line.
- **Unchanged contracts:** API request and response contracts, every M2 data-access contract, and all M2 tests. The only planned M2 test edit is the migration list in the migrate test, which gains `003`.
- **Coverage:** `packages/telemetry` joins the coverage gate at 80% line coverage.

## Compose services and health checks

These facts come from each image's published Dockerfile and default configuration at the pinned tags:

| Service          | Image facts                                                                                                                                                                                                                                                                                                                                                                                         | Health check                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `otel-collector` | Built `FROM scratch`, so there is no shell and no `wget` or `curl`. Its stock config enables `health_check` without an endpoint, and recent collectors default component endpoints to `localhost`.                                                                                                                                                                                                  | No Compose healthcheck is possible. Our collector config sets `health_check.endpoint: 0.0.0.0:13133`, published as host port 13133. Host check: `curl -fsS localhost:13133/`.                                                                                                                                                                               |
| `jaeger`         | Alpine base, so it has busybox `wget`. Its built-in config binds every endpoint to `${JAEGER_LISTEN_HOST:-localhost}`: UI and query on 16686, OTLP on 4317 and 4318, and `healthcheckv2` on 13133. The published 2.22.0 image already sets `JAEGER_LISTEN_HOST=0.0.0.0` in its environment; the spike confirmed it with `docker image inspect`, and the host could reach Jaeger without setting it. | **Compose sets `JAEGER_LISTEN_HOST=0.0.0.0` explicitly anyway**, so the binding doesn't depend on an image default that could change. Compose healthcheck: `wget -q -O /dev/null http://127.0.0.1:13133/status`. The spike confirmed `/status` returns 200. Host checks: `curl -fsS localhost:16686/` and the health endpoint published as host port 13134. |
| `prometheus`     | busybox base, so it has `wget`.                                                                                                                                                                                                                                                                                                                                                                     | Compose healthcheck: `wget -q -O /dev/null http://127.0.0.1:9090/-/ready`. Host check: `curl -fsS localhost:9090/-/ready`.                                                                                                                                                                                                                                  |

- **Health path.** `/status` is `healthcheckv2`'s default path. The spike confirmed it returns 200 on 2.22.0, both in the container and from the host.
- **Not a dependency.** The apps do not `depends_on` the telemetry services. Telemetry is optional, and an app must start and stay healthy without it.
- **Collector startup.** `docker compose up --wait` treats the collector, which has no healthcheck, as ready once it is running. Criterion 6 adds the host-side check.
- **Ports.** The collector's Prometheus exporter, 8889, and Jaeger's OTLP ports stay on the Compose network only. The published host ports are 13133, 16686, 13134, 9090 and 4318. Publishing 4318 lets `pnpm dev` send telemetry to the collector.

## Dependencies

**Rule:** pin exact versions only, and only releases at least 14 days old when pinned. Brand-new majors wait until they have matured.

**What was checked in the npm registry on 2026-10-23:**

- **The 3.0 and 0.300 line:** `@opentelemetry/api` 1.10.0, the 3.0.0 SDK packages, the 0.300.0 exporters and instrumentation, and `instrumentation-pg` 0.77.0 all exist and pin each other exactly. They require Node 22.15 or later, which Node 24.20 meets, and the API peer range `>=1.10.0 <1.11.0` is satisfied.
  - But the whole line was published on **2026-10-20, three days before this review**.
  - It is a new major that renames packages: `sdk-trace` 3.0 replaces `sdk-trace-base` and `sdk-trace-node`, and its types export a generic `TracerProvider` with no Node-specific provider.
  - Nothing in it has had a patch release yet.
  - So: valid and internally consistent, but too new to pin.
- **The 2.12 and 0.223 line,** published on 2026-10-06 and therefore 17 days old: it pins itself exactly and supports Node 24, with engines `^18.19.0 || >=20.6.0`.
  - It provides `NodeTracerProvider` through `sdk-trace-node` 2.12.0.
  - **npm deprecation notices:** `sdk-trace-base` 2.12.0 and `sdk-trace-node` 2.12.0 are both marked deprecated, with the message "Use @opentelemetry/sdk-trace package". pnpm prints these warnings at install. They still pass all four verification checks: they exist, their peer dependencies are satisfied, they support Node 24, and they are 17 days old. Both are thin packages over `@opentelemetry/sdk-trace` 2.12.0, which they depend on.
  - `@opentelemetry/instrumentation` 0.223.0 ships `hook.mjs`. It has no export map, so the deep import resolves directly.
  - The SDK peer ranges require `@opentelemetry/api` below 1.10.0, which means 1.9.1.
  - `instrumentation-pg` 0.75.0, also from 2026-10-06, depends on core `^2.9.0`, instrumentation `^0.223.0`, and `sql-common` `^0.42.0`, which resolves to 0.42.0 on core `^2.0.0`.
- pnpm has no minimum-release-age policy configured in this repository.

**Proposed pins: the 2.12 and 0.223 line.**

| Package                                      | Version | Published  | Why                                                       |
| -------------------------------------------- | ------- | ---------- | --------------------------------------------------------- |
| `@opentelemetry/api`                         | 1.9.1   | 2026-03-25 | Satisfies every 2.12 peer range, which require `<1.10.0`. |
| `@opentelemetry/core`                        | 2.12.0  | 2026-10-06 | SDK core.                                                 |
| `@opentelemetry/resources`                   | 2.12.0  | 2026-10-06 | Resource attributes.                                      |
| `@opentelemetry/sdk-trace-base`              | 2.12.0  | 2026-10-06 | Batch and simple processors, in-memory exporter.          |
| `@opentelemetry/sdk-trace-node`              | 2.12.0  | 2026-10-06 | `NodeTracerProvider`, with AsyncLocalStorage context.     |
| `@opentelemetry/context-async-hooks`         | 2.12.0  | 2026-10-06 | AsyncLocalStorage context manager.                        |
| `@opentelemetry/sdk-metrics`                 | 2.12.0  | 2026-10-06 | Meter provider, periodic and manual readers.              |
| `@opentelemetry/exporter-trace-otlp-proto`   | 0.223.0 | 2026-10-06 | OTLP over HTTP, traces.                                   |
| `@opentelemetry/exporter-metrics-otlp-proto` | 0.223.0 | 2026-10-06 | OTLP over HTTP, metrics.                                  |
| `@opentelemetry/instrumentation`             | 0.223.0 | 2026-10-06 | Instrumentation base and `hook.mjs`.                      |
| `@opentelemetry/instrumentation-http`        | 0.223.0 | 2026-10-06 | HTTP server spans.                                        |
| `@opentelemetry/instrumentation-pg`          | 0.75.0  | 2026-10-06 | `pg` spans. Only if the spike passes.                     |
| `@opentelemetry/semantic-conventions`        | 1.43.0  | 2026-07-09 | Attribute and metric names.                               |

**Why the deprecated tracing packages are kept for M3.** `sdk-trace-base` and `sdk-trace-node` 2.12.0 are the configuration the spike actually tested end to end: ESM hooks, `pg` and `http` spans, failure isolation, and the bounded flush. `@opentelemetry/sdk-trace` 2.12.0 is not deprecated and was published the same day, but it exports only a generic `TracerProvider`, not the same class as `sdk-trace-node`'s `NodeTracerProvider`. Using it means registering the AsyncLocalStorage context manager and propagator by hand, which is untested here. M3 does not switch to an untested setup.

**Follow-up, outside M3:** evaluate `@opentelemetry/sdk-trace` 2.12.0 with `@opentelemetry/context-async-hooks` 2.12.0 as a replacement for the deprecated packages. It needs its own spike, repeating the auto-instrumentation self-test, the failure test and the shutdown test, and its own decision record. That evaluation can be combined with adopting the 3.0 line once that line has patch releases and has been out for at least 14 days.

**Deliberately not used:**

- `@fastify/otel`: on the 2.12 line it is dependency-compatible, but the `onRequest` hook makes it unnecessary.
- `@opentelemetry/sdk-node`: it pulls in gRPC, Zipkin, Prometheus and logs packages.
- `@opentelemetry/instrumentation-pino`: the mixin replaces it.

**Containers:** each tag was checked on Docker Hub, and each Dockerfile was read at its tag.

| Image                                  | Tag         | Pushed     | Instead of                               |
| -------------------------------------- | ----------- | ---------- | ---------------------------------------- |
| `otel/opentelemetry-collector-contrib` | **0.162.0** | 2026-10-05 | 0.163.2, pushed 2026-10-21, two days old |
| `jaegertracing/jaeger`                 | 2.22.0      | 2026-10-06 | unchanged                                |
| `prom/prometheus`                      | **v3.15.0** | 2026-09-25 | v3.15.1, pushed 2026-10-21, two days old |

All three are multi-architecture images that include `amd64` and `arm64`.

## Test strategy

- **Deterministic tests,** in Vitest with Postgres, the same style as M2:
  - `packages/telemetry` provides an in-memory test SDK: `InMemorySpanExporter` with `SimpleSpanProcessor`, the AsyncLocalStorage context manager, and `InMemoryMetricExporter` with a manual reader that the test triggers.
  - Tests assert span names, parents, links and link attributes, attributes, metric names and units, label keys and values, and log fields.
  - They synchronize on events and blocked fakes, never on wall-clock time. The shutdown tests use fake timers.
- **Database spans:**
  - If the spike passes, a `node --test` smoke test runs the built output through the production `--import` entrypoint with an in-memory exporter, and asserts the `pg` spans.
  - If the fallback is used, the explicit spans are asserted directly in Vitest.
- **End-to-end:** Compose, with Jaeger's v3 query API and Prometheus's HTTP API, using generous polling timeouts.
- **Not asserted:** collector internals, and exact Prometheus scrape timing.

## Acceptance criteria

[D] is a deterministic test, and [E2E] is a Compose check. All of M2's 145 tests keep passing throughout.

### M3a: foundation

1. [D] **Off by default.** Without `OTEL_EXPORTER_OTLP_ENDPOINT`, no SDK starts and no network call is made. The full M2 suite passes unchanged.
2. [D] **Config validation.** Invalid telemetry config exits with code 1 and names the variable, before any exporter or metric reader is constructed. Covered cases:
   - a malformed endpoint;
   - an interval or timeout below its minimum;
   - `OTEL_METRIC_EXPORT_INTERVAL` below `OTEL_METRIC_EXPORT_TIMEOUT`, for example 1000 with 3000, where the message names both variables;
   - the defaults of 5000 and 3000 are accepted.
3. [D] **Log mixin.** A line logged inside an active span carries `trace_id` and `span_id` equal to that span's context. A line logged outside a span has neither field.
4. [D] **Probes excluded.** `/healthz` and `/readyz` create no spans and add nothing to `http.server.request.duration`.
5. [D] **Database spans,** by the path the spike chose. Either way, no span records SQL parameter values.
   - **automatic:** the `node --test` smoke run under the production `--import` entrypoint records `pg` spans with `db.system.name = "postgresql"`, parented to the request or pass span that issued them, and records no spans for queries made outside a span;
   - **fallback:** every data-access function used by the API and worker emits `db.<function>` under the active span, and nothing outside one.
6. [E2E] **Compose health.**
   - `docker compose up --build --wait` succeeds, and Jaeger and Prometheus report healthy through their Compose healthchecks.
   - From the host, `localhost:13133/` (collector), `localhost:16686/` (Jaeger UI), `localhost:13134/status` (Jaeger health) and `localhost:9090/-/ready` (Prometheus) all return 200.
   - The apps are healthy.
   - [D] **Config-file test.** A test parses the committed infrastructure configs and asserts:
     - the collector's trace exporter is `otlp_grpc/jaeger`, and no exporter uses the deprecated `otlp` name;
     - the Prometheus scrape job for the collector has `honor_labels: true`;
     - the Compose `jaeger` service sets `JAEGER_LISTEN_HOST=0.0.0.0`;
     - the collector's log shows no deprecation warning at startup.

### M3b: per-pass traces

7. [D] **Creation context stored.** `POST /orders` stores a `traceparent` equal to the `order.create` span's context. Both that span and the HTTP server span carry `order.id`. An idempotent replay leaves the stored value unchanged.
8. [D] **Each pass is its own trace.** Covered for a charge pass, a retry, a reconciliation pass and a `payment_unknown` recheck.
   - Each pass has a new trace id, different from the creation trace and from every other pass.
   - Its root `order.process` span carries `order.id` and the pass attributes, and links to the stored creation context with link attribute `order.id`.
   - The `payment.charge` and `payment.lookup_or_void` spans are its children, with `payment.result` and `payment.replayed` and no payment reference.
9. [D] **Recovery and release spans.**
   - A recovery sweep that recovers N orders emits one `worker.recover_claims` root span with `claims.recovered = N`, and N `order.claim_recovered` children. Each child carries its `order.id` and links to that order's creation context.
   - Each order's `claim_recovered` log line carries the sweep's trace id and its own child's span id.
   - A sweep that recovers nothing emits no span.
   - Shutdown release behaves the same way, with `worker.release_claims` and its `order.claim_released` children, including unconfirmed ones.
10. [D] **Missing context.** An order without `trace_context` processes exactly as in M2. Its pass span, and any recovery or release child span, has no link and has `order.trace_context_missing = true`.
11. [D] **No context leakage.** Two concurrent passes are held open by a blocking fake provider. Then:
    - they have different trace ids;
    - every child span's parent belongs to its own pass;
    - each pass's log lines carry only its own trace id;
    - the loop's claim and recovery code runs with no active span.
12. [E2E] **Correlation in Jaeger.** The test is timed so that a slow export or index can't be mistaken for a correlation defect:
    - **Precondition:** the order is placed through the API, and the test polls `GET /orders/:id` until it is `paid`. Its pass span has then ended, and both apps' batch processors flush within their 1 s schedule delay.
    - **Window:** `query.startTimeMin` is the order's `createdAt` from the API response minus 10 minutes. `query.startTimeMax` is recomputed on every poll as the current time plus 1 minute. Both are always supplied as RFC 3339. The broad bounds tolerate clock skew between the host, the Docker VM and the containers. `query.searchDepth` is omitted.
    - **Polling:** from the moment the order is seen as `paid`, the test polls `GET /api/v3/traces?query.attributes={"order.id":"<id>"}&query.startTimeMin=…&query.startTimeMax=…` every 500 ms, for up to 10 s, until both traces are present. Only a miss after the full 10 s fails the test. The expected latency is about 2 s: a 1 s batch delay, a 200 ms collector batch, and immediate in-memory indexing.
    - **Diagnosis on failure:** the test fetches each trace id it can find by id, `GET /api/v3/traces/{traceId}`. From M3b, the creation trace id comes from `orders.trace_context`. It then reports whether a trace was missing entirely, which points to export or indexing, or present without the expected attribute or link, which is a correlation defect.

    Within that window, the search returns two traces:
    - the creation trace, with the HTTP server span, `order.create` and database spans;
    - the pass trace, with `order.process`, database spans and `payment.charge`, whose root links to the creation trace id.

    `GET /api/v3/traces/{creationTraceId}` returns the creation trace.

    A control request without the time bounds returns HTTP 400. That guards against a Jaeger upgrade silently changing the contract.

    **Automated, local only:** `pnpm e2e:jaeger` runs exactly this procedure against the Compose stack, from `packages/telemetry/e2e/jaeger-correlation.js`. It exits 1 with diagnostics naming the trace ids it could find. It is not a CI gate, because CI has no Compose stack.

### M3c: metrics

13. [D] **Catalog and cardinality.**
    - Every instrument's name, kind, unit and label keys match the metrics table exactly, read back from the in-memory reader.
    - Label values belong to the closed sets: `http.route` is a template or absent, an unknown method becomes `_OTHER`, and `commerce.orders` reports all five statuses.
    - After traffic over 20 distinct orders and one unmatched URL, the number of distinct series doesn't grow with order count, and no label value contains an order id, SKU, raw URL, payment reference or error message.
14. [D] **Metrics pool isolation.**
    - The order-status sampler uses only the metrics pool. The worker pool's and the simulator pool's connection counts are unchanged by sampling.
    - With the database down, or the sample query blocked past its timeout, the sampler skips quietly, stale counts expire, nothing is thrown, and a concurrent pass completes with its M2 outcome.
15. [E2E] **Prometheus series.** Within 30 s of mixed traffic, including one 422 request, Prometheus returns series, using the names the spike confirmed, for:
    - the request-duration histogram, with `http_route="/orders"` and a `422` status label;
    - `commerce_orders` for all five statuses;
    - `db_client_connection_count` for each of the four pools;
    - `commerce_worker_passes_total` and `commerce_payment_calls_total`.

    **Job and instance labels:**
    - worker series carry `job="worker"` and `instance` equal to the worker's `WORKER_ID`, `worker-1` in Compose;
    - API series carry `job="orders-api"` and `instance` equal to its `service.instance.id`;
    - no series of these metrics has an `exported_job` or `exported_instance` label.

### Across M3

16. [D] and [E2E] **Telemetry failures never disrupt orders.**
    - [D] With an exporter that throws or never settles, order and pass outcomes match M2 exactly, and no pass waits on export.
    - [D] **Diagnostic rate limiting.** With a fake clock, 1,000 exporter-failure diagnostics spread over a simulated 10-minute outage, of two message kinds, produce at most 2 log lines per simulated minute, so no more than 22 in total. Each line after the first of its kind carries the correct `suppressed` count. When the clock advances past 60 s, the next message of a kind is logged again.
    - [E2E] With `otel-collector` stopped, orders are still created and reach `paid`, and both apps stay healthy. After the collector restarts, traces and metrics resume.
    - [E2E] **No log flood.** With the collector stopped for 3 minutes under steady traffic, each app writes at most 3 OpenTelemetry diagnostic lines per message kind over that period.
17. [D] **M2 intact, and quality gates pass.**
    - All M2 tests pass unchanged, including the shutdown criteria 23, 24 and 35.
    - The three shutdown-isolation tests in "Shutdown" pass:
      - `flushWithinBudget` with fake timers;
      - the orchestration order;
      - the M2 shutdown scenarios re-run with a never-settling exporter, giving identical results.
    - No unhandled rejection is emitted at any point.
    - Format check, lint, typecheck, build, and the coverage gate pass on a clean copy, with `packages/telemetry` included at 80% or more.

## Verification commands

```sh
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test:coverage
docker compose up -d --build --wait
curl -fsS -o /dev/null -w '%{http_code}\n' localhost:13133/          # 200, collector health
curl -fsS -o /dev/null -w '%{http_code}\n' localhost:13134/status    # 200, Jaeger health
curl -fsS -o /dev/null -w '%{http_code}\n' localhost:16686/          # 200, Jaeger UI
curl -fsS -o /dev/null -w '%{http_code}\n' localhost:9090/-/ready    # 200
curl -s -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"items":[{"sku":"SKU-00042","quantity":1}],"paymentMethod":"pm_card_ok"}'
curl -s -G localhost:16686/api/v3/traces \
  --data-urlencode 'query.attributes={"order.id":"<id>"}' \
  --data-urlencode "query.startTimeMin=$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)" \
  --data-urlencode "query.startTimeMax=$(date -u -v+1M +%Y-%m-%dT%H:%M:%SZ)"
curl -s -G localhost:9090/api/v1/query --data-urlencode 'query=max by (order_status) (commerce_orders)'
curl -s -G localhost:9090/api/v1/query --data-urlencode 'query=count by (job, instance) (commerce_worker_passes_total)'
# expect job worker with instance worker-1, and no exported_job or exported_instance labels
docker compose logs worker | grep '"trace_id"'
docker compose stop otel-collector    # orders still 201, then paid
```

## Spike outcome

The M3a compatibility spike ran on 2026-10-23, outside the repository, with the pins above. The 14-day minimum-age gate was enforced by pnpm for every package, transitive ones included. Every OpenTelemetry package resolved to a single version.

| Spike step                      | Result                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic `pg` and `http` spans | **Passed** 8 of 8 checks, on host Node 24.20 and on `node:24-slim` (Node 24.22.1): route-named server span, `pg` spans parented under the request and a pass span, no spans outside a span or for probes, no SQL parameter values, no startup warnings.                                                                     |
| Explicit-span fallback          | **Not needed**, so not implemented.                                                                                                                                                                                                                                                                                         |
| Jaeger 2.22.0                   | Healthy. `/status` returns 200 in the container and from the host. The v3 search by `order.id` returned the creation, pass and recovery-sweep traces. Links carry the creation trace id and `order.id`. The old `/api/traces` search returns 404. The v3 search needs both time bounds.                                     |
| Collector 0.162.0               | Healthy, and forwards to Jaeger and Prometheus. With a refused endpoint and with a hanging one, all 141 requests in each run succeeded at baseline latency, with 0 unhandled rejections and 0 uncaught exceptions. Errors appeared only as OpenTelemetry diagnostics.                                                       |
| Prometheus v3.15.0              | Healthy. All 11 metric names match the expected translations. `honor_labels: true` is needed for `job` and `instance`.                                                                                                                                                                                                      |
| Bounded flush                   | Four mock-timer tests pass. With M2's real worker code and a hanging exporter, 20 orders were paid, `shutdownWorker` returned M2's drained result `{ exitCode: 0, drained: true }`, the flush timed out at 316 ms against its 300 ms budget, and the process exited with code 0 after 318 ms, with no unhandled rejections. |

## Known risks

- **Fastify release age.** The repository's existing `fastify` 5.12.7, from M1 and M2, was published 2026-10-13, so it is younger than the 14-day rule. The rule applies to new pins, and Fastify is not an M3 pin. The spike exempted only that package from its age gate. **M3 does not upgrade or change Fastify.** Any change to it is a separate decision.
- **Production runtime drift.** The Dockerfile uses the floating `node:24-slim` tag. During the spike, a pull moved it to Node 24.22.1, while the host runs 24.20.0. Builds can therefore change the runtime without a code change. Proposed **separate change, reviewed on its own and outside M3:** pin the base image to an exact Node patch version with an image digest, for example `node:24.x.y-slim@sha256:…`, align `.nvmrc` and the CI Node version with it, and record the decision. M3 does not change the Dockerfile.
- **The explicit-span fallback stays unnecessary.** Automatic `pg` instrumentation passed the spike, so the fallback is not built. If a future upgrade of the instrumentation or the hook packages breaks the self-test, the fallback in "Database spans" is the documented remedy.
- **Deprecated tracing packages.** See "Dependencies" for why they are kept for M3, and the follow-up evaluation of `@opentelemetry/sdk-trace` 2.12.0.
- **ESM hook regressions.** Automatic instrumentation depends on `import-in-the-middle` 3.5.2 and `require-in-the-middle` 8.0.1, which are resolved transitively. The M3a smoke test, criterion 5, runs the production `--import` entrypoint, so a regression is caught in CI.
- **`module.register` deprecation.** `@types/node` 24 marks `node:module`'s `register()` as deprecated in favor of `module.registerHooks()`. The preload uses `register()`, because it is the path OpenTelemetry 0.223 documents and the spike tested. Node 24 prints no runtime deprecation warning for it, which the diag-wiring smoke test checks by requiring empty stderr. Moving to `registerHooks()` is a follow-up, to be evaluated together with the `sdk-trace` follow-up and re-tested with the same smoke tests.
- **Shutdown margin.** In M2's worst case, drain plus release plus cleanup can approach 8 s. The flush budget then shrinks to `skipped`, and the hard timer still applies as in M2.
