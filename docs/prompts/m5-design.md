# M5 design: fault scenarios and incident bundles

Status: **M5a approved by the repository owner on 2026-10-25. The M5b contract addendum is approved as design on 2026-10-25; M5b implementation and M5c remain not approved.** M5a is committed in `d1579ec`; its GitHub Actions result is not yet confirmed. The bundle contract is recorded in ADR 0007.

## Scope

**In scope:**

- `packages/faults`: the scenario registry, a per-process fault controller, and the injection hooks. It is inert unless `FAULTS_ENABLED=true`.
- Five scenarios from the architecture document, each reproducible from its name and a seed.
- Scenario control endpoints on the orders API and the worker, which exist only when `FAULTS_ENABLED=true`. M7 uses the API's endpoints.
- `packages/incident-bundle`: bundle schema version 1. M5a adds the ground-truth schema; M5b adds the manifest and line-format schemas, the writer and the validator.
- `apps/incident`: a host CLI that runs a scenario end to end, captures telemetry and writes a bundle.
- A new load-generator profile, `incident`, used as background traffic.

**Out of scope:**

- Analyzing or diagnosing incidents. That belongs to the separate Engineering Operations AI repository.
- Any UI (M7). Changes to order outcomes, the lifecycle or M2's shutdown contract when no scenario is active.
- Exporting logs through the collector, and new OpenTelemetry log packages. See "Telemetry capture".
- The missing-index and worker-crash scenarios. See "Scenarios not in M5".

**Delivery:** three parts, each with its own commit and CI run, like M3.

| Part    | Delivers                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M5a** | `packages/faults`, the five scenarios, the controller, the admin endpoints, the app wiring behind `FAULTS_ENABLED`, the ground-truth contract and its schema in `packages/incident-bundle`, safe shutdown, and the tests. |
| **M5b** | The rest of `packages/incident-bundle` (manifest and line-format schemas, writer, validator), the telemetry capture clients, and the `incident` load profile.                                                             |
| **M5c** | `apps/incident` (the CLI), the orchestration, and the live end-to-end validation, which needs the owner's approval.                                                                                                       |

## Sources

**Specified by repository docs:**

- **Roadmap, M5:** at least five scenarios from the architecture document; each off by default, verified by a test; the same seed gives identical ground truth, the same affected components and the same primary symptom; each primary symptom is visible in exported telemetry within 2 minutes of the trigger; bundles validate against a versioned schema.
- **Architecture:** a fault package inert unless enabled, and an incident tool that writes `incidents/<scenario>-<seed>-<timestamp>/` with `manifest.json`, `traces.jsonl`, `metrics.jsonl`, `logs.jsonl` and `ground_truth.json`. Faults are enabled by environment variables, or by admin endpoints that exist only when `FAULTS_ENABLED=true`. Only the fault package decides whether a fault is active; call sites ask it. The bundle schema is versioned, and a breaking change needs a new major version and an ADR.
- **CLAUDE.md:** every scenario is reproducible from a scenario name and a seed. Each needs a test that it triggers and a test that it is off by default. Fault injection lives in one dedicated package. Bundles and generated telemetry are never committed.
- **M4 design:** M5's runner calls `createLoadGenerator` in-process, M5 may add profiles with their own golden hashes, and a bundle manifest records the profile, seed, plan hash and run prefix.
- **Roadmap, M7:** the UI lists and starts demo scenarios through the M5 scenario endpoints, enabled only in demo mode.

## Scenarios

Each scenario has fixed parameters and, where useful, parameters derived from the seed with the M4 generator (mulberry32, splitmix32 stream derivation). The default timeline is the same for all five: background load starts at T, the fault is triggered at T + 30 s and lasts 90 s, then 30 s of recovery follow.

| Scenario                 | Fault and hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Primary symptom (exported telemetry)                                                                                                                                                                                                                                                                | Affected components             | Cleanup                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bad-deploy-order-reads` | API: a pre-handler on `GET /orders/:id` fails 40% of requests with an internal error, as a bad release behind a config flag would. Which requests fail comes from a seeded stream.                                                                                                                                                                                                                                                                                             | `http_server_request_duration_seconds_count` for `http_route="/orders/:id"` and status `500` increases.                                                                                                                                                                                             | `orders-api`                    | Stop, expiry or shutdown turns the flag off. No data changes.                                                                                                                                                                                                                                                  |
| `payment-timeouts`       | Worker: the payment provider wrapper never answers 60% of `charge` calls, so each times out after `PAYMENT_TIMEOUT_MS` (5 s). Which calls hang comes from a seeded stream. The underlying simulator is not called for them, so no charge is recorded.                                                                                                                                                                                                                          | `commerce_payment_calls_total` for `payment_operation="charge"`, `payment_result="error"` increases, and payment duration p95 reaches the timeout.                                                                                                                                                  | `worker`, `payment-provider`    | Stop, expiry or shutdown restores the wrapper and rejects every still-pending call it holds. A handler is attached before each call returns, so a late rejection is never unhandled. Affected orders retry, then reconcile; with no recorded charge, lookups void them and they end `failed`, releasing stock. |
| `provider-outage`        | Worker: the wrapper rejects every `charge` and `lookupOrVoid` with `ProviderError('provider_unavailable')`, immediately.                                                                                                                                                                                                                                                                                                                                                       | `commerce_payment_calls_total` for `payment_operation="lookup_or_void"`, `payment_result="error"` increases.                                                                                                                                                                                        | `worker`, `payment-provider`    | Stop, expiry or shutdown restores the wrapper. Orders that parked in `payment_unknown` keep their stock until the next recheck (`PAYMENT_UNKNOWN_RECHECK_MS`, 15 min), then void and fail.                                                                                                                     |
| `api-pool-exhaustion`    | API: the fault checks out every connection of the API pool (10) and holds it, as a connection leak would. It keeps requesting connections until it holds all 10, so requests already in flight finish first.                                                                                                                                                                                                                                                                   | `http_server_request_duration_seconds_count` for `http_route="/orders"`, `http_request_method="POST"` and status `500` increases: each order creation waits the pool's 2 s connect timeout, then fails. Secondary: `db_client_connection_pending_requests` for the `orders-api` pool rises above 0. | `orders-api`, `orders-api-pool` | Stop, expiry or shutdown releases every held client. During the fault, requests waiting longer than the 2 s connect timeout fail with 500, and `/readyz` returns 503.                                                                                                                                          |
| `poison-order`           | Worker: a processor hook makes any pass of an order containing the poison SKU hang until the fault stops. The SKU is derived from the seed. The incident CLI places one order with it at the trigger, and any background order that happens to contain the SKU is affected too. Each claim of such an order hangs one worker slot; after the 60 s claim timeout it is recovered and claimed again, hanging another. With the default 5 slots, the worker can stall completely. | `commerce_claims_recovered_total` for `order_status="pending"` increases about 60 s after the trigger; `commerce_worker_inflight` stays raised.                                                                                                                                                     | `worker`                        | Stop, expiry or shutdown releases the hung passes, which end with an error. Each affected order stays `processing` until its claim expires, up to 60 s, is recovered, and then processes normally.                                                                                                             |

**Timing against the 2-minute requirement**, with the defaults: the bad-deploy, payment-timeout and pool symptoms appear within seconds. Provider-outage lookup errors start about 3 s after the first affected order, once its three charge attempts fail (backoff 1 s, then 2 s). Orders park after about 80 s (reconciliation backoff 5, 10, 20, 40 s). The poison-order recovery appears at about 60 s. Metrics then need one export interval (5 s) and one scrape (5 s) to reach Prometheus.

**Fault realism.** Injected errors use the same error paths and messages as real failures. No log line, span or metric names the scenario or says "fault". Ground truth lives only in `ground_truth.json`.

**Component identifiers** used by M5 are `orders-api`, `worker`, `payment-provider` and `orders-api-pool`. They are open strings under ADR 0007. `postgres` is not listed for `api-pool-exhaustion`: the held connections are idle sessions, 10 of Postgres's default 100, and Postgres itself is not degraded.

### Scenarios not in M5

- **Missing index on a growing table.** It would mean dropping an index on the live database. At local table sizes, thousands of rows, a sequential scan stays sub-millisecond, so no symptom would appear within 2 minutes.
- **Stuck claims after a worker crash.** It would mean killing the worker container. M2's deterministic tests already cover crash recovery.

Both stay candidates for a later milestone. Neither is needed for the roadmap's five.

## Fault activation across processes

- **Off by default.** Both apps read `FAULTS_ENABLED` at startup, validated with Zod. Only `true` enables it. Anything other than `true` or `false` exits 1 and names the variable. The base `compose.yaml` does not set it.
- **When disabled:** the fault controller is a no-op. Every hook is a pass-through that returns the original object or does nothing. No admin route is registered, so the paths return 404. No scenario can become active.
- **When enabled:** each process has an in-memory controller with at most one active scenario. A scenario becomes active only through a start request. An environment variable can never start one, so enabling the feature never changes behavior by itself.
- **Control path:**
  - The **orders API** is the single control point: `POST /admin/scenarios/:name/start`, `POST /admin/scenarios/stop`, `GET /admin/scenarios` (the list) and `GET /admin/scenarios/active` (the report).
  - On start, the API validates the request, activates its own part of the scenario, then forwards the start to the **worker's** health server, which has the same endpoints, at `WORKER_ADMIN_URL`. If the worker does not confirm, the API rolls back its activation and answers 502.
  - Stop is idempotent and is forwarded the same way. The report shows both processes' state.
- **Bounds:** the request body is `{ "seed": 0..4294967295, "durationMs": 1000..600000 }`, validated with Zod. Starting while a scenario is active returns 409. Every activation expires on its own at `durationMs`, so a crashed CLI never leaves a fault running.
- **Compose:** a separate override, `compose.faults.yaml`, sets `FAULTS_ENABLED=true` for both apps and `WORKER_ADMIN_URL=http://worker:3001` for the API. Starting the stack with it is an explicit, separate step. No M5a criterion needs it, so it arrives in M5c with the live checks.
- **No telemetry leakage,** whether faults are enabled or not, because a request to a disabled path still reaches the API's 404 handler:
  - **Incoming:** any path under `/admin/` is added to the probe exclusions in `packages/telemetry`. It creates no server span, records no request metric, and is logged only at `debug`, on the API and on the worker's health server.
  - **Outgoing:** the API forwards to the worker with Node's built-in `fetch`. The SDK registers only the HTTP and pg instrumentations, and `fetch` uses undici, so it creates no client span today. A test asserts that forwarding produces no span, so adding undici instrumentation later cannot leak silently.
  - **Logs and metrics:** the fault package logs nothing at `info` or above, and no log message, span attribute or metric label carries a scenario name, a seed or the word "fault".
  - **Second guard:** the capture step drops any span or log line for an `/admin/` path.
- **Shutdown.** On SIGTERM each app stops its fault controller first, before its existing shutdown steps, as the worker already does for its order-status sampler:
  - the API releases every held pool client before `app.close()` and `pool.end()`, so `pool.end()` never waits on a held connection;
  - the worker releases hung poison-order passes, which end with an error, and rejects every pending payment-timeout call, before `shutdownWorker` drains;
  - the bad-deploy flag turns off.

  `shutdownWorker`, the exit codes, the 7 s drain and the 8 s hard deadline are unchanged.

- **Hooks**, at the seams the architecture reserved: the API pool (pool exhaustion), a Fastify pre-handler on the order read route (bad deploy), the worker's payment provider (timeouts, outage), and the processor's existing `beforeStep` hook (poison order). Call sites ask the controller; they never read environment variables.

## Admin endpoint contracts

All responses are JSON with stable field names, ISO 8601 timestamps, and the existing error shape `{ error, message, details? }`, following the "Frontend readiness" rules. Request bodies and parameters are validated with Zod.

| Endpoint                            | Success                                                                                                                                                                  | Errors                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/scenarios`              | 200 `{ scenarios: [{ name, version, description, affectedComponents, defaultDurationMs }] }`, sorted by name                                                             | none                                                                                                                                                                    |
| `POST /admin/scenarios/:name/start` | 202 `{ activation: { scenario, version, seed, durationMs, startedAt, expiresAt, processes: { "orders-api": "active", worker: "active" } } }`                             | 400 `validation_error` with `details`; 404 `scenario_not_found`; 409 `scenario_active`, with the active scenario in `details`; 502 `worker_unavailable`, after rollback |
| `POST /admin/scenarios/stop`        | 200 `{ stopped: boolean, scenario: string \| null }`; stopping when nothing is active returns `stopped: false`                                                           | 502 `worker_unavailable`, after stopping the API's own part                                                                                                             |
| `GET /admin/scenarios/active`       | 200 `{ active: activation \| null, processes: { "orders-api": state, worker: state } }`, where a worker that cannot be reached reports `{ error: "worker_unavailable" }` | none                                                                                                                                                                    |

The worker's health server serves the same four endpoints for its own process, without forwarding. When faults are disabled, none of these routes exist, and the paths return each app's standard 404 response.

## Reproducibility and ground truth

### Ground-truth contract

`ground_truth.json` is part of M5a. Its Zod schema lives in `packages/incident-bundle`, with its generated JSON Schema file at `docs/schemas/incident-bundle/v1/ground-truth.schema.json`. M5b adds the rest of the bundle around it.

| Field                 | Content                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`       | `"1.0.0"`                                                                                                                                       |
| `scenario`            | `{ name, version, seed }`. `version` is an integer per scenario, raised whenever its definition changes in a way that changes its ground truth. |
| `description`         | One paragraph, fixed per scenario.                                                                                                              |
| `rootCause`           | `{ component, summary }`.                                                                                                                       |
| `affectedComponents`  | Sorted, unique component identifiers.                                                                                                           |
| `faultParameters`     | A flat object of the scenario's parameters, fixed and seed-derived, such as the failure rate or the poison SKU.                                 |
| `timeline`            | `{ triggerOffsetMs: 30000, durationMs: 90000 }`, relative to the load start, for runs made by the incident CLI.                                 |
| `primarySymptom`      | One condition, in the format below.                                                                                                             |
| `secondarySymptoms`   | Further conditions, informational: a run is not required to observe them.                                                                       |
| `dataEffects`         | Plain-language statements of what the fault does to orders and stock.                                                                           |
| `expectedRemediation` | Plain-language steps an operator would take.                                                                                                    |

**Condition format.** A condition is structured data, not a query string, so any consumer can render it for its own backend:

```json
{
  "signal": "metric",
  "metric": "commerce_payment_calls_total",
  "matchers": { "job": "worker", "payment_operation": "charge", "payment_result": "error" },
  "evaluation": "increase",
  "windowSeconds": 60,
  "comparison": "gt",
  "threshold": 0,
  "deadlineSeconds": 120,
  "description": "Charge calls to the payment provider fail."
}
```

- `metric` and `matchers` use the Prometheus names and label keys produced by the collector's translation (M3 design, "Metrics"), and matchers are exact equality.
- `evaluation` is `increase` for counters and `max_over_time` for gauges. `comparison` is `gt`, `gte`, `lt` or `lte`.
- The incident CLI renders a condition as `sum(<evaluation>(<metric>{<matchers>}[<windowSeconds>s])) <comparison> <threshold>`, with `max` in place of `sum` for `max_over_time`.

**Primary-symptom conditions** for the five scenarios. Every condition uses a 60 s window, a threshold of 0 with `gt`, and a 120 s deadline.

| Scenario                 | Metric and matchers                                                                                                                               | Evaluation | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bad-deploy-order-reads` | `http_server_request_duration_seconds_count{job="orders-api", http_route="/orders/:id", http_response_status_code="500"}`                         | `increase` | **Verified.** Name and labels are in the M3 catalog and were present in Prometheus in M3c's live check. A normal order read returns only 200 or 404, so the baseline is zero.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `payment-timeouts`       | `commerce_payment_calls_total{job="worker", payment_operation="charge", payment_result="error"}`                                                  | `increase` | **Verified.** Labels are in the catalog. The load profiles send only `pm_card_ok` and `pm_card_declined`, which the simulator always answers, so charge errors are zero without the fault.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `provider-outage`        | `commerce_payment_calls_total{job="worker", payment_operation="lookup_or_void", payment_result="error"}`                                          | `increase` | **Verified.** Lookups happen only after an unknown charge outcome, which normal traffic never produces, so the baseline is zero.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `api-pool-exhaustion`    | `http_server_request_duration_seconds_count{job="orders-api", http_route="/orders", http_request_method="POST", http_response_status_code="500"}` | `increase` | **Verified.** The API creates its pool with only a connection string, so `createPool`'s 2,000 ms default connect timeout applies. `createOrder` calls `pool.connect()`, which pg-pool rejects with "timeout exceeded when trying to connect" once every connection is held. The route has no catch, and the error handler maps any status of 500 or more, or none, to 500 `internal_error`. The `onResponse` hook records it with the route template and the normalized method. Baseline zero: the handler's own outcomes are 201, 200 (replay), 400, 409 and 422, and M4's criterion 11 run recorded all 836 creates in its window as successful, with no failed status. The pending-request gauge stays a secondary symptom, because its baseline under load was never measured. |
| `poison-order`           | `commerce_claims_recovered_total{job="worker", order_status="pending"}`                                                                           | `increase` | **Verified.** Claims are recovered only when one expires after 60 s, which normal passes, lasting milliseconds, never reach. The counter has no series until its first increment, which the condition handles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Determinism

- **What it depends on:** `ground_truth.json` is a pure function of the scenario name, the scenario's `version`, the seed and the schema version. It is written as canonical JSON: UTF-8, keys sorted, two-space indentation, and a final newline.
- **What it does not contain:** timestamps, run IDs, order IDs or the producer commit. The commit is recorded in `manifest.json`.
- **Guarantee:** two bundles made by the same producer commit for the same scenario and seed have byte-identical ground truth. A different commit gives the same ground truth unless the scenario's `version` or the schema version changed.
- **Excluded from deterministic comparison:** everything in `manifest.json`, which records timestamps, the bundle ID, the run prefix, the Git commit, versions, file checksums and the observed detection time. Also the telemetry files, whose IDs, timestamps and order IDs vary from run to run.
- **What must match** for two runs with the same scenario and seed from the same commit:
  - `ground_truth.json` is byte-identical, so the affected components and the primary symptom are identical too;
  - both runs observe the primary symptom within 2 minutes;
  - the load plan hash is the same, from M4.

## Incident bundle contract

The contract is defined in ADR 0007. In summary:

- **Files:** `manifest.json`, `ground_truth.json`, `traces.jsonl`, `metrics.jsonl` and `logs.jsonl` in `incidents/<scenario>-<seed>-<timestamp>/`. The `incidents/` directory is already ignored by Git.
- **Schema:** version `1.0.0`. The source of truth is Zod schemas in `packages/incident-bundle`, which uses the existing `zod` dependency. The ground-truth schema arrives in M5a, the others in M5b. Zod 4's `z.toJSONSchema` generates JSON Schema (draft 2020-12) files, committed under `docs/schemas/incident-bundle/v1/`, with a test that fails if they drift. Objects are loose, allowing additional properties, so that consumers on an older 1.x schema accept newer 1.x bundles.
- **Validation:** `pnpm incident validate <dir>` checks every file against its schema, the manifest's checksums, byte counts and record counts, and the supported major version. No new validator dependency is added.
- **Line formats:**
  - `traces.jsonl`: one trace per line as OTLP JSON (`{ "resourceSpans": [...] }`).
  - `metrics.jsonl`: one Prometheus series per line, with its name, labels and `[unixSeconds, value]` samples.
  - `logs.jsonl`: one normalized log record per line, with service, time, level, message, attributes, and `trace_id` and `span_id` when present.

## Telemetry capture

After the run, the CLI reads the backends that already exist. It adds no new dependency, changes no collector configuration, and changes no app logging.

| File            | Source                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `traces.jsonl`  | Jaeger's v3 API: traces for `orders-api` and `worker` in the run window, at most 5,000 per service, with truncation recorded in the manifest. The result-limit parameter, `query.searchDepth`, is verified in Jaeger's v2.22.0 source; see "Jaeger trace capture" below. Jaeger returns the spans of all matching traces in one OTLP JSON response, so the capture regroups them into one trace per line. |
| `metrics.jsonl` | Prometheus `query_range` for the 11 catalog metrics over the window plus 1 minute on each side, at a 5 s step.                                                                                                                                                                                                                                                                                            |
| `logs.jsonl`    | `docker compose logs --no-log-prefix --timestamps --since --until`, once per service, for `orders-api` and `worker`, parsed as the apps' pino JSON. Lines that are not JSON are kept as plain messages.                                                                                                                                                                                                   |

**M3's deferred log export:** M3 moved log export through the collector, and telemetry files, to M5. This design resolves that without new OpenTelemetry log packages. The logs are captured from container stdout, and the incident CLI writes the telemetry files. M5b updates `docs/architecture.md` to match.

## M5b contract addendum

This section makes the M5b contract concrete. The repository owner approved it as design on 2026-10-25; M5b implementation needs separate approval. Facts are cited to the repository or to Jaeger's v2.22.0 source. Choices those facts do not dictate, such as slice sizes, are decisions, and are marked as such.

### Bundle documents

All objects are loose (`z.looseObject`), as ADR 0007 requires: a consumer ignores fields it does not know, and a 1.x producer may add optional fields. Timestamps are ISO 8601 UTC strings with milliseconds, such as `2026-10-25T14:03:07.250Z`. Identifiers follow ADR 0007's open vocabulary, `^[a-z][a-z0-9-]*$`.

**`manifest.json`.** Volatile, never compared byte for byte. Written as canonical JSON, like the ground truth, so diffs stay readable.

| Field            | Type                                                                                                        | Required           | Content                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`  | semver string                                                                                               | yes                | `"1.0.0"`. The validator accepts major 1 only.                                                                                                                                                       |
| `bundleId`       | string                                                                                                      | yes                | `<scenario>-<seed>-<timestamp>`, equal to the directory name. The timestamp is `YYYYMMDDTHHMMSSZ`.                                                                                                   |
| `createdAt`      | timestamp                                                                                                   | yes                | When the writer started.                                                                                                                                                                             |
| `scenario`       | `{ name, version, seed }`                                                                                   | yes                | The same values as in `ground_truth.json`; the validator checks that they agree.                                                                                                                     |
| `window`         | `{ loadStartedAt, loadEndedAt, captureFrom, captureTo }`                                                    | yes                | `captureFrom` and `captureTo` bound the telemetry queries.                                                                                                                                           |
| `trigger`        | `{ startedAt, stoppedAt, requestedDurationMs }`                                                             | yes                | The actual trigger window. `stoppedAt` is a timestamp or `null` if the stop was not confirmed.                                                                                                       |
| `detection`      | `{ detectedAt, latencyMs, deadlineSeconds }`                                                                | yes                | The observed primary-symptom detection. `detectedAt` and `latencyMs` are `null` when it was not detected.                                                                                            |
| `producer`       | `{ repository, commit, dirty }`                                                                             | yes                | `"commerce-platform"`, the 40-character lowercase commit hash, and whether the working tree had changes.                                                                                             |
| `services`       | array of `{ name, version, instanceId }`                                                                    | yes, at least one  | The services that produced telemetry.                                                                                                                                                                |
| `infrastructure` | `{ images: { <service>: <image ref> } }`                                                                    | yes                | Image tags, such as `"jaeger": "jaegertracing/jaeger:2.22.0"`.                                                                                                                                       |
| `load`           | `{ profile, seed, planHash, runPrefix }`                                                                    | yes                | From M4. `planHash` is 64 lowercase hex characters.                                                                                                                                                  |
| `capture`        | object, below                                                                                               | yes                | How the telemetry was captured, including truncation.                                                                                                                                                |
| `files`          | `{ "ground_truth.json", "traces.jsonl", "metrics.jsonl", "logs.jsonl" }`, each `{ sha256, bytes, records }` | yes, all four keys | `sha256` is 64 lowercase hex characters of the file's bytes; `bytes` is its size; `records` is 1 for `ground_truth.json` and the line count for a JSONL file. The manifest does not describe itself. |

`capture` contains:

- `traces`: `{ source: "jaeger-v3", sliceSeconds, minSliceSeconds, searchDepth, maxTracesPerService, droppedAdminSpans, services: [{ name, traces, saturatedSlices, truncated, truncationReasons }] }`. `truncationReasons` is a subset of `["slice_saturated", "service_cap"]`.
- `metrics`: `{ source: "prometheus", stepSeconds, series: [{ name, seriesCount }] }`, one entry per Prometheus name below, including those with no series.
- `logs`: `{ source: "docker-compose", services: [{ name, records, nonJsonLines, droppedAdminLines }] }`.

**JSONL rules.** UTF-8. Every record is one line ending in `\n`, and there are no blank lines. An empty file has zero records and is valid.

**`metrics.jsonl`.** One Prometheus series per line, sorted by `name` and then by the canonical JSON of `labels`:

```json
{
  "name": "commerce_payment_calls_total",
  "labels": {
    "instance": "…",
    "job": "worker",
    "payment_operation": "charge",
    "payment_replayed": "false",
    "payment_result": "error"
  },
  "samples": [
    [1792940630, "3"],
    [1792940635, "5"]
  ]
}
```

- `name`: the Prometheus metric name. `labels`: every label except `__name__`, all string values.
- `samples`: `[unixSeconds, value]` pairs in ascending time order. `unixSeconds` is a number. `value` is the string Prometheus returns, unchanged. **Why a string:** Prometheus's HTTP API itself returns sample values as strings, and a value can be `NaN`, `+Inf` or `-Inf`, for example a histogram's `+Inf` bucket bound or a rate over no data. JSON numbers cannot represent those, so converting would either fail or lose them. Consumers parse the string as a float.

**`logs.jsonl`.** One normalized record per line, in time order per service, with the services concatenated in name order:

```json
{
  "service": "orders-api",
  "time": "2026-10-25T14:03:07.250Z",
  "level": "error",
  "message": "request errored",
  "attributes": { "reqId": "req-1f", "err": { "…": "…" } },
  "trace_id": "…32 hex…",
  "span_id": "…16 hex…"
}
```

`service`, `time`, `level`, `message` and `attributes` are required. `trace_id` (32 hex) and `span_id` (16 hex) are present only when the source line had them.

**`traces.jsonl`.** One trace per line, as an OTLP JSON `TracesData` object, `{ "resourceSpans": [...] }`. Validation is **structural, not semantic**:

- checked: the line is an object with a non-empty `resourceSpans` array; each entry has a `scopeSpans` array; each span has a string `name`, a 32-hex `traceId`, a 16-hex `spanId` and a string `startTimeUnixNano`; and every span on a line has the same `traceId`;
- not checked: the rest of OTLP, such as parent links, span kinds, attribute value types and timestamp order. All objects stay loose.

The hex IDs follow Jaeger's JSON output. The M3 e2e script matches the `traceId` from `/api/v3/traces` against the hex `trace_id` in the apps' logs.

**Contract impact.** The Engineering Operations AI repository validates these files with the committed JSON Schema files. Required fields and their types bind it from 1.0.0 on. Adding optional fields later is a minor version. Structural trace validation lets it use any OTLP reader without the schema rejecting valid OTLP.

**Tests (B1, B2, B3).**

- A drift test for each generated JSON Schema file: `manifest`, `metrics-record`, `logs-record` and `trace-record`.
- Loose objects accept unknown fields.
- One valid fixture bundle passes.
- One fixture per defect fails with the file and field named: a missing file, a malformed JSON line, a line that breaks its schema, a trace line mixing two trace IDs, each of a SHA-256, byte or record mismatch, major version 2, and a manifest whose scenario disagrees with the ground truth.
- The writer's output validates.
- An interrupted write leaves no directory under the final name.
- Writing to an existing bundle directory fails.

### Package boundaries

- `packages/incident-bundle`: schemas, generated JSON Schema files, the canonical JSON writer, the bundle writer and the validator. It does file I/O, using `node:fs` and `node:crypto`, but no network calls and no child processes.
- **Decision:** create `apps/incident` in M5b with only `src/capture/` (`jaeger.ts`, `prometheus.ts`, `logs.ts`), each taking injected dependencies:
  - `fetch`;
  - `runCommand(command, args) => Promise<{ exitCode, stdout, stderr }>`;
  - a clock.

  There is no `main.ts`, `bin` or `incident` script until M5c. The capture modules join the enforced coverage list.

- _Alternatives:_ capture inside `packages/incident-bundle` would mix child processes and HTTP into the contract package. A separate `packages/telemetry-capture` would add a package whose only consumer is the CLI.
- **Contract impact:** none. The consumer sees only the files.
- **Tests:** each client is tested only against stubs. No test reaches Jaeger, Prometheus or Docker.

### Prometheus capture

The capture makes one `GET /api/v1/query_range` per Prometheus name, with the bare name as the query, from `captureFrom − 60 s` to `captureTo + 60 s`, at a 5 s step. These are the M3 catalog's translated names (`docs/prompts/m3-design.md`, "Metrics"), which the M3 spike confirmed against collector 0.162.0 and Prometheus v3.15.0:

| Catalog metric                          | Kind                       | Prometheus names                                                |
| --------------------------------------- | -------------------------- | --------------------------------------------------------------- |
| `http.server.request.duration`          | histogram                  | `http_server_request_duration_seconds_bucket`, `_count`, `_sum` |
| `db.client.connection.count`            | observable up-down counter | `db_client_connection_count`                                    |
| `db.client.connection.pending_requests` | observable up-down counter | `db_client_connection_pending_requests`                         |
| `db.client.connection.max`              | observable up-down counter | `db_client_connection_max`                                      |
| `commerce.orders`                       | observable gauge           | `commerce_orders`                                               |
| `commerce.worker.passes`                | counter                    | `commerce_worker_passes_total`                                  |
| `commerce.worker.inflight`              | observable gauge           | `commerce_worker_inflight`                                      |
| `commerce.payment.calls`                | counter                    | `commerce_payment_calls_total`                                  |
| `commerce.payment.duration`             | histogram                  | `commerce_payment_duration_seconds_bucket`, `_count`, `_sum`    |
| `commerce.claims.recovered`             | counter                    | `commerce_claims_recovered_total`                               |
| `commerce.claims.released`              | counter                    | `commerce_claims_released_total`                                |

That is 15 names for 11 metrics. A name with no series, such as an unused counter, is valid and is recorded with `seriesCount: 0`. At most about 60 points per series, well under Prometheus's 11,000-point limit.

**Completeness test.** It declares the kind of each catalog metric. It then asserts that the kind table's keys equal `Object.values(METRIC)`, and that the capture's name list equals what the translation rule gives from that table. So a new catalog metric without a mapping fails the test. Further tests: query parameters, empty results, label handling (`__name__` removed, `le` kept), sorting, and a non-200 response failing with the metric name.

### Log capture and normalization

- **Command, per service:** `docker compose logs --no-log-prefix --timestamps --since <captureFrom> --until <captureTo> <service>`, for `orders-api` and `worker` separately. Without the prefix, two services in one call could not be told apart.
  - `--timestamps` gives every line, including one that is not JSON, a time. The capture strips the timestamp prefix before parsing.
- **pino fields,** as configured in both apps' `main.ts`. A line looks like `{"level":30,"time":1792940632657,"service":"orders-api",…,"msg":"…"}`. The mixin adds `trace_id` and `span_id`.
- **Level:** `10 trace`, `20 debug`, `30 info`, `40 warn`, `50 error`, `60 fatal`, from pino's `levels.values`. Any other value becomes `"unknown"`, with the original kept as `attributes.pinoLevel`.
- **Time:** `new Date(time).toISOString()` from pino's epoch milliseconds. If `time` is missing or not a finite number, the Docker timestamp is used instead.
- **Message:** `msg`, or `""` when absent.
- **Attributes:** every other field except `level`, `time`, `msg`, `service`, `trace_id` and `span_id`. That includes the worker's `workerId`, and Fastify's `reqId`, `req`, `res` and `err`.
- **Lines that aren't JSON,** including JSON that is not an object: `level: "unknown"`, `message` is the raw line, `attributes: {}`, and the time comes from the Docker timestamp. They are counted in `nonJsonLines`.
- **`/admin` filter:** a record is dropped when `req.url` is a string whose path, before any `?`, is exactly `/admin` or starts with `/admin/`. This uses the same rule as `ADMIN_PATH_PREFIX` in `packages/telemetry`, so `/administrator` and `/products/admin` are kept. Dropped records are counted in `droppedAdminLines`.
  - **Follow-up records:** Fastify logs `req.url` only on "incoming request"; its "request completed" line has `reqId` and `res`, but no URL. A later record from the same service is also dropped when its `reqId` equals a dropped request's `reqId`, but only where that link is reliable. Fastify's `reqId` is a per-process counter, so the link holds within one container lifetime: it ends at the next "incoming request" with the same `reqId`, or at a container restart, detected by the counter starting over. A record whose link cannot be established this way is kept, never guessed.
  - Both are second guards. M5a already logs `/admin` requests only at `warn` and above, which normal requests never reach.
- **Tests:** each level mapping; time conversion; the Docker-timestamp fallback; lines that aren't JSON; trace fields present and absent; `/admin`, `/admin/x?y` and `/admin` with a query dropped; `/administrator`, `/products/admin` and probes kept; the `reqId` follow-up dropped; per-service ordering; and a failing `runCommand` reported with its stderr.

### Jaeger trace capture

**Verified in Jaeger v2.22.0 source** (paths under `github.com/jaegertracing/jaeger`, tag `v2.22.0`):

- `cmd/jaeger/internal/extension/jaegerquery/internal/apiv3/query_parser.go`:
  - the result limit is `query.searchDepth` (`paramSearchDepth`);
  - `query.search_depth` and `query.num_traces` are deprecated aliases;
  - the value is parsed with `strconv.ParseUint(n, 10, 32)`.
- `cmd/jaeger/internal/extension/jaegerquery/querysvc/conversion.go`, `toReaderQuery`:
  - both `query.startTimeMin` and `query.startTimeMax` are required, and min must be before max;
  - a depth above `tracestore.MaxSearchDepth` is refused with "search depth must be in [0, 10000]";
  - a depth of 0 becomes `DefaultSearchDepth`.
- `internal/storage/v2/api/tracestore/reader.go`: `const MaxSearchDepth uint32 = 10000`.
- `cmd/jaeger/internal/extension/jaegerquery/querysvc/service.go`:
  - `const DefaultSearchDepth uint32 = 100`;
  - `FindTraces` refuses pagination (`ErrPaginationUnsupportedByFindTraces`), so `/api/v3/traces` cannot page.
- `internal/storage/v2/memory/tenant.go`, `findTraceAndIds`:
  - the in-memory store walks its ring buffer from the most recently inserted trace backwards, and stops after `SearchDepth` matches;
  - a trace matches if any of its spans for the service starts within `[startTimeMin, startTimeMax]`, both ends included (`spanStartsWithin`);
  - a depth above the store's `max_traces` is refused.
- `cmd/jaeger/internal/all-in-one.yaml`, embedded by `cmd/jaeger/internal/command.go` as the default config when none is given, as in our Compose file: memory storage with `max_traces: 100000`.
- `cmd/jaeger/internal/extension/jaegerquery/internal/apiv3/http_gateway.go`, `returnTraces`:
  - an empty result is HTTP 404 with `"No traces found"`;
  - otherwise the response is `{ "result": { "resourceSpans": [...] } }`, with every matching trace's resource spans combined into one list.

Consequences: without `query.searchDepth`, a search silently returns at most 100 traces. A full result can't be told apart from a truncated one except by counting. Any single search returns at most 10,000 traces.

**Capture** (decisions built on those facts):

1. For each of `orders-api` and `worker`, cover `[captureFrom, captureTo]` with 10 s slices. Each slice sends `query.serviceName`, `query.startTimeMin`, `query.startTimeMax` and `query.searchDepth=1000`, all as RFC 3339.
2. A 404 whose body says "No traces found" is an empty slice. Any other non-200 response fails the capture with the status and Jaeger's message.
3. Spans are grouped by `traceId`. Each trace becomes one `TracesData` line, keeping each span's resource and scope. A trace found in several slices or for both services appears once.
4. **Saturation:** a slice that returns exactly `searchDepth` distinct traces may be missing older traces, because the store keeps the most recently inserted matches. Such a slice is split in half and both halves are queried again, down to a 1 s minimum. A saturated 1 s slice counts in `saturatedSlices` and adds `slice_saturated`.
5. **Cap:** at most 5,000 traces per service, as the design says. When the cap is reached, capture for that service stops and `service_cap` is added.
6. Before writing, spans whose `url.path`, `http.target` or `http.route` falls under `/admin` are dropped, and a trace left with no spans is dropped. They are counted in `droppedAdminSpans`.

`truncated` is true exactly when `truncationReasons` is not empty. _Expected volume:_ the `incident` profile is 10 rps for 150 s, about 1,500 API traces plus about 375 to 750 worker pass traces, so about 100 to 150 per 10 s slice. Neither saturation nor the cap should occur. The 10 s slice and the initial depth of 1,000 are decisions that bound each response's size; they are not measured, and M5c's live runs may tune them.

**Contract impact:** the consumer learns from `capture.traces` whether the trace set is complete, and why not. Line order isn't meaningful.

**Tests (B4),** against a stubbed `fetch` that implements the matching rules above:

- slice boundaries and exact query parameters;
- a 404 treated as empty, and a 400 surfaced;
- a saturated slice split down to 1 s and then reported as `slice_saturated`;
- the cap reported as `service_cap`;
- deduplication across slices and services;
- one trace per line, with resource and scope kept;
- `/admin` spans dropped and counted.

### `incident` load profile and the M4 test exception

- **Decision:** add `INCIDENT` to the existing closed registry in `apps/loadgen/src/profiles.ts`:
  - `name: 'incident'`, `ratePerSecond: 10`, `durationMs: 150_000`, `warmupMs: 0`;
  - otherwise the steady profile's rules: mix, list, create and read settings.

  Its golden hash is recorded in a new test only after its plan contents are checked, as M4 did for steady. The steady profile's golden hash must stay unchanged.

- **Approved exception to "all M2 to M4 tests keep passing, unchanged":** `apps/loadgen/test/cli.test.ts:70` asserts `/--profile: unknown profile "burst"; available: steady/`. Registering a second profile changes the message to `available: incident, steady`, so the assertion becomes `/--profile: unknown profile "burst"; available: incident, steady/`. That is the only change to an existing test. M4's design allows it ("Profiles are a closed registry. M5 may add profiles, such as bursts, each with its own golden hash test"). The CLI's behavior for valid profiles doesn't change.
- _Alternatives:_
  - keep `INCIDENT` outside the registry, so no M4 test changes but `pnpm loadgen --profile incident --dry-run` can't show its hash;
  - change the error message format, which is a larger M4 behavior change.
- **Contract impact:** the manifest's `load.profile` is `"incident"`, and its `planHash` is reproducible from the profile and seed.
- **Tests (B5):** the incident/42 golden hash; a different seed gives a different hash; the plan summary (1,500 entries, no warm-up, the mix shares); the steady/42 golden hash unchanged; the updated CLI assertion.

### Unresolved

- **Where `services[].version`, `services[].instanceId` and `infrastructure.images` come from.** The schema defines them, but how they are filled is M5c's orchestration: trace resource attributes, or Compose. Not evidenced yet.
- **Whether a bundle is written when the symptom is not detected.** The schema allows `detection.detectedAt: null`. M5c decides, and the exit code is already defined as non-zero.
- The `reqId` follow-up drop rests on Fastify's default request logging and its per-process counter. The log level for `/admin` routes makes it moot today.
- The real trace volume per slice under the `incident` profile has not been measured. That needs a live run, in M5c.

## Incident CLI

`apps/incident`, run on the host like the load generator:

- `pnpm incident list` and `pnpm incident ground-truth --scenario <name> --seed <n>`: no network calls.
- `pnpm incident validate <dir>`: no network calls.
- `pnpm incident run --scenario <name> --seed <n>`, the live run:
  1. **Preflight:** the API and the worker answer `/readyz` with 200, faults are enabled (`GET /admin/scenarios` returns 200), no scenario is active, and Jaeger and Prometheus are ready. Otherwise it stops with a message.
  2. **Load:** `createLoadGenerator` with the `incident` profile (10 rps for 150 s) and the same seed, including M4's preflight.
  3. **Trigger:** at T + 30 s, `POST /admin/scenarios/<name>/start` with a duration of 90 s. For `poison-order`, it also places one order containing the poison SKU.
  4. **Watch:** it polls Prometheus every 5 s, for up to 120 s after the trigger, for the primary symptom condition from the ground truth. The detection time is recorded in the manifest.
  5. **Stop:** at T + 120 s it stops the scenario. Stop also runs in a `finally` path on any error or SIGINT.
  6. **Flush:** when the load ends, it waits 15 s for export and scraping.
  7. **Capture and write:** it captures the telemetry for the window, writes the bundle atomically to a temporary directory and renames it into place, then validates it.
  8. **Exit:** 0 only if the symptom was detected within 120 s and the bundle validates.

**The `incident` load profile:** 10 rps for 150 s with no warm-up, using the steady mix rules. That is 1,500 entries, about 375 orders and about 1,100 units of stock per run. It gets its own golden hash. The steady profile and its golden hash do not change.

## Prerequisites

- M4 is complete. Its documentation closeout was committed separately in `6b5c4c5`.
- For M5c's live checks: the Compose stack started with `compose.faults.yaml`, which recreates `orders-api` and `worker`, and enough stock. The M4 preflight checks the stock.

## Acceptance criteria

[D] is a deterministic test in CI. [L] is a live check against the Compose stack, which needs the owner's separate approval. All M2 to M4 tests keep passing, unchanged.

### M5a: fault package and scenarios

- **A1** [D] **Off by default.** With `FAULTS_ENABLED` unset or `false`, both apps register no admin route, so the paths return the standard 404, and the controller reports no active scenario. For each of the five scenarios, a test shows its hook is a pass-through: same object, same result, no delay.
- **A2** [D] **Config.** `FAULTS_ENABLED` accepts only `true` or `false`, and any other value exits 1 naming it. `WORKER_ADMIN_URL` is validated only when faults are enabled.
- **A3** [D] **Activation.** For each scenario, starting it produces its fault in-process: 500s on order reads, hung charges that time out, provider errors, a fully held pool that makes `POST /orders` return 500 `internal_error` after the 2 s connect timeout, and a hung pass for any order with the poison SKU. No existing test covers a database failure on `POST /orders`, so this one is new. Stopping it, and expiry on a fake clock, remove the fault, release every held connection and hung pass, and reject every pending payment-timeout call, with no unhandled rejection.
- **A4** [D] **Bounds.** One active scenario per process. A start while one is active returns 409. Seed and duration bounds are enforced. Unknown scenario names return 404.
- **A5** [D] **Cross-process control.** An API start is forwarded to the worker. A worker failure rolls back the API's activation and returns 502. Stop is idempotent. The report shows both processes, including an unreachable worker.
- **A6** [D] **Admin contracts.** Every endpoint returns the documented JSON. Invalid bodies, parameters, seeds and durations return 400 `validation_error` with `details`. Every error uses the `{ error, message, details? }` shape, and timestamps are ISO 8601.
- **A7** [D] **Ground-truth contract and determinism.**
  - Each scenario's ground truth validates against the ground-truth schema, and the committed JSON Schema file matches the Zod schema, enforced by a drift test.
  - For each scenario, the ground truth for a name and seed is byte-identical across calls and processes, and equals a committed golden file for seed 42.
  - A different seed changes only the seed-derived parameters, never the affected components or the primary symptom's metric, matchers or condition.
  - Each primary symptom's metric name and label keys exist in the M3 metric catalog.
- **A8** [D] **Symptom in telemetry.** With the in-memory meter, each active scenario moves exactly the series its primary-symptom condition names: for `api-pool-exhaustion`, the request-duration count with route `/orders`, method `POST` and status 500. Timing-dependent cases use a fake clock, and the claim-recovery case ages the claim in the test database, as the M2 tests do.
- **A9** [D] **No leakage.**
  - Requests under `/admin/`, enabled or disabled, create no server span, record no request metric and log nothing at `info`.
  - The API's forwarding to the worker creates no client span.
  - No log message, span attribute or metric label contains a scenario name, a seed or the word "fault".
- **A10** [D] **Safe shutdown during each scenario.** For each of the five scenarios, a shutdown while it is active:
  - stops the controller first, releasing held pool clients, hung passes and pending payment calls, and turning the flag off;
  - keeps the existing results: the API exits 0 within its 8 s deadline, `pool.end()` does not wait on a held connection, `shutdownWorker` returns the M2 results with exit code 0 when everything drains, and no unhandled rejection occurs;
  - leaves `shutdownWorker` and the M2 and M3 shutdown tests unchanged.
- **A11** [D] **Quality gates.** Format check, lint, typecheck, build, coverage at 80% per new module, and the smoke tests pass.

### M5b: telemetry capture and bundle schema

- **B1** [D] **Schema v1.** The Zod schemas cover the manifest and each line format, next to M5a's ground-truth schema. The generated JSON Schema files under `docs/schemas/incident-bundle/v1/` match, enforced by a drift test.
- **B2** [D] **Validator.** A valid fixture bundle passes. Each defect class fails with a message naming the file and the field: a missing file, a malformed line, a checksum, byte-count or record-count mismatch, an unsupported major version.
- **B3** [D] **Writer.** It writes the five files atomically, through a temporary directory and a rename, with checksums, and its output validates.
- **B4** [D] **Capture.** Against stubbed Jaeger, Prometheus and `docker compose logs`, the clients produce the three files, regroup spans into one trace per line, drop `/admin/` spans and log lines, and record truncation. The Jaeger result-limit parameter is verified against Jaeger 2.22 before the client is written.
- **B5** [D] **Profile.** The `incident` profile is registered with a golden plan hash. The steady profile's golden hash is unchanged.
- **B6** [D] **Quality gates**, as in A11.

### M5c: incident CLI and end-to-end validation

- **C1** [D] **CLI.** Invalid arguments exit 1 naming the problem. `ground-truth`, `list` and `validate` make no network calls.
- **C2** [D] **Orchestration.** On a fake clock with stubbed services: the preflight stops on each failing check, the trigger happens at T + 30 s, polling stops at detection or at 120 s, the scenario is always stopped (including on error), and capture, write and validate happen in order.
- **C3** [L] **Each scenario end to end.** `pnpm incident run --scenario <name> --seed 42` exits 0 for all five. Each detects its primary symptom within 120 s of the trigger, and each bundle validates.
- **C3a** [L] **Symptom in the bundle.** Each bundle's `metrics.jsonl` contains the series named by the ground truth's primary-symptom condition, the same condition the CLI polls for, and its samples satisfy that condition after the trigger.
- **C3b** [L] **No leakage in the bundle.** No bundle contains a span or log line for an `/admin/` path, and no telemetry file contains a scenario name.
- **C4** [L] **Reproducibility.** A second run of each scenario with seed 42 gives a byte-identical `ground_truth.json`, and observes the same primary symptom within 120 s.
- **C5** [L] **Cleanup.** After each run, neither process has an active scenario, both apps are healthy, the API pool holds no leaked connections, and worker in-flight passes return to 0.
- **C6** [D] **Docs and gates.** Architecture, README and roadmap match the implementation, and every check passes.

**Roadmap criteria covered:** at least five scenarios (A3, A7, C3); off by default (A1); same seed, same ground truth and symptom (A7, C4); visible within 2 minutes (A8, C3, C3a); schema validation (A7, B1, B2, C3).

## Validation commands

```sh
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test:coverage && pnpm test:smoke
pnpm incident list
pnpm incident ground-truth --scenario provider-outage --seed 42
pnpm incident validate incidents/<bundle-dir>
# Live, only with the owner's approval:
docker compose -f compose.yaml -f compose.faults.yaml up -d --build --wait
pnpm incident run --scenario bad-deploy-order-reads --seed 42
```

## Checks that need the owner's separate approval

- Starting the stack with `compose.faults.yaml`, which recreates `orders-api` and `worker`.
- Every `pnpm incident run`. Each creates about 375 real orders and uses about 1,100 units of stock.
- C3 and C4 together are ten runs: about 3,750 orders and 11,000 units.
- During a run, `api-pool-exhaustion` makes the API return 500s and fail `/readyz` for 90 s.
- `provider-outage` parks orders in `payment_unknown` with their stock held for up to 15 minutes.

## Resolved decisions

- **D1: the `api-pool-exhaustion` primary symptom** is HTTP 500 responses on `POST /orders`, as in the condition table above. Its baseline is zero by the handler's defined outcomes and by M4's live evidence, and the fault produces it on every order creation that waits out the 2 s connect timeout. Pending pool requests, closest to the root cause, are kept as a secondary symptom, because their baseline under load is unmeasured.

## Known risks

- **Bundle size.** At 10 rps, a run has a few thousand traces. Traces are capped at 5,000 per service, with truncation recorded.
- **Jaeger memory.** Jaeger keeps traces in memory. Many runs grow it until the container restarts.
- **Host variance.** Live timings depend on the laptop. The 2-minute deadline has a wide margin for four scenarios. `provider-outage` parks at about 80 s, but its primary symptom, lookup errors, appears within seconds.
- **Stock.** Every live run consumes stock, and `pnpm db:seed` never restores it. The M4 preflight stops a run that starts short.
- **Realism versus safety.** The faults are in-process imitations of real failures. Their nature is documented in each scenario's ground truth, as ADR 0001 requires.
- **Reachable fault controls.** Compose publishes the API and worker ports on every interface. With `compose.faults.yaml`, anyone on the local network can start a scenario. This design does not add network restrictions; enabling faults is a deliberate, local step.
- **Approval.** Starting the stack with `compose.faults.yaml`, and every live incident run, needs the owner's separate approval. Live runs consume stock and grow Jaeger's in-memory store.
