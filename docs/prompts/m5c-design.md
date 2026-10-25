# M5c design: incident CLI and end-to-end runs

Status: **Approved for implementation by the repository owner on 2026-10-25; implemented and committed, with the runtime isolation blockers resolved; CI confirmed by the repository owner on 2026-10-25.** The deterministic behavior is implemented and covered by unit tests. Open items 1 to 3 (section 14) were verified with container-integration evidence and accepted by the owner on 2026-10-25, and are recorded as `true` in `RUNTIME_VERIFICATION` in `apps/incident/src/isolation.ts`. The stack now runs with `compose.faults.yaml`: the API, worker, Jaeger and Prometheus publish only on `127.0.0.1`, from an image that includes M5a, and the CLI's isolation checks pass against it. `pnpm incident capture-check` passed all 13 checks against the stack on 2026-10-25, without writing anything. Item 4 remains unverified, and no live run has been made; each live run still needs the owner's separate approval.

Every decision carries one label:

- **[Existing]** approved earlier and, where noted, implemented;
- **[Proposed]** part of this contract, awaiting the owner's approval;
- **[Open]** not settled by repository evidence; listed in section 14, with the verification needed to settle it.

## 1. Goals and non-goals

**Goals.**

- [Existing] `pnpm incident list`, `ground-truth`, `validate` and `run`, as in `m5-design.md`, "Incident CLI", with criteria C1 to C6.
- [Proposed] `pnpm incident capture-check`, a non-destructive preflight (section 8.3).
- [Proposed] A `run` that fails closed:
  - local targets only;
  - one run at a time;
  - a deadline on every step;
  - one canonical, bounded cleanup on every handled exit path.
- [Proposed] Reports that state four things separately, and never present failed, invalid or truncated evidence as complete:
  1. the run outcome;
  2. bundle validity;
  3. evidence state;
  4. the cleanup result.

**Non-goals.**

- Diagnosing incidents, which belongs to the Engineering Operations AI repository.
- New fault scenarios or controls. The M5a admin endpoints are the only fault interface.
- Any change to the M5b manifest or record schemas, the M5b capture clients, or ADR 0007.
- Running the CLI in a container. It is a host tool, like `pnpm loadgen`.
- OCI image labels (deferred, section 13).
- Any UI (M7).

## 2. Components and data flow

| Component                             | Responsibility                                                                                               | Status                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `apps/incident/src/capture/*`         | Jaeger, Prometheus and log capture; each calls `fetch(url)` or `runCommand(cmd, args)` with no other options | [Existing] M5b                                      |
| `packages/incident-bundle`            | Schemas (including `BUNDLE_ID`), writer, validator                                                           | [Existing] M5b                                      |
| `packages/faults`                     | `buildGroundTruth`, `SCENARIOS`, `SCENARIO_NAMES`, `poisonSku`                                               | [Existing] M5a                                      |
| `apps/loadgen`                        | `createLoadGenerator`, the `incident` profile                                                                | [Existing] M4 and M5b; hooks [Proposed] (section 3) |
| Orders API `/admin/scenarios/*`       | Start, stop, list and report, forwarded to the worker                                                        | [Existing] M5a                                      |
| `apps/incident/src/config.ts`         | Arguments and environment, validated with Zod                                                                | [Proposed]                                          |
| `apps/incident/src/isolation.ts`      | Local-target, Docker context and Compose checks, shared by `run` and `capture-check`                         | [Proposed]                                          |
| `apps/incident/src/lock.ts`           | The exclusive run lock                                                                                       | [Proposed]                                          |
| `apps/incident/src/redact.ts`         | Removes credentials from records and failure messages                                                        | [Proposed]                                          |
| `apps/incident/src/control.ts`        | Client for the four admin endpoints                                                                          | [Proposed]                                          |
| `apps/incident/src/detect.ts`         | Renders the primary-symptom condition and polls Prometheus                                                   | [Proposed]                                          |
| `apps/incident/src/metadata.ts`       | Producer commit, image tags and services, for the manifest                                                   | [Proposed]                                          |
| `apps/incident/src/budget.ts`         | Deadline-aware `fetch` and `runCommand` wrappers with retries (section 7)                                    | [Proposed]                                          |
| `apps/incident/src/evidence.ts`       | `.failed/` preservation (section 6)                                                                          | [Proposed]                                          |
| `apps/incident/src/run.ts`            | Phases, lifecycles, deadlines and the cleanup algorithm                                                      | [Proposed]                                          |
| `apps/incident/src/cli.ts`, `main.ts` | Argument parsing, report output, exit codes; `main.ts` is a thin entry, like loadgen's                       | [Proposed]                                          |

The CLI computes the ground truth locally. It reads the fault controls and backends over HTTP, and Docker through the `docker` CLI. It writes only under `INCIDENTS_DIR`. Nothing in the apps or the backends depends on the CLI.

## 3. Load-generator lifecycle hooks (P1)

[Proposed] Two optional, additive fields on `LoadGeneratorOptions` in `apps/loadgen`. This is an M4 interface change and needs its own unit tests. Existing M4 tests stay unchanged.

- **`onPlanStart?: (atMs: number) => void`**
  - Called **once**, synchronously, when the workload plan starts, before the first plan entry is scheduled. That is after M4's preflight has passed, not when `run()` is called.
  - Never called when the preflight fails or the run is cancelled first.
  - `atMs` is the injected `Clock`'s `now()` at that moment, in **milliseconds**. The default clock is `monotonicClock` (`performance.now()`), so `atMs` is monotonic and not a wall-clock time.
  - If the callback throws, `run()` rejects with that error before any plan request is sent.
- **`signal?: AbortSignal`**
  - **Already aborted** when `run()` is called: `run()` rejects with `signal.reason` and sends no request.
  - **Aborted during M4's preflight:** the preflight's requests are aborted, `onPlanStart` is not called, and `run()` rejects.
  - **Aborted during the plan:**
    - no new entry is scheduled;
    - every in-flight request is aborted, combining its 5 s request timeout with the signal;
    - `run()` rejects with `signal.reason` once in-flight requests have settled.
  - **Bound:** at most 64 requests are in flight (`MAX_IN_FLIGHT`). Each settles when aborted, or at the latest after its 5 s timeout (`REQUEST_TIMEOUT_MS`), so `run()` settles within 5 s of the abort plus event-loop latency.
  - A cancelled run returns no report.

**Unchanged:** plan generation, the plan hash, the `steady` profile and its golden hash, the `incident` golden hash, the load generator CLI and its output. With neither field set, behavior is exactly as today.

**Unit tests required:**

- `onPlanStart` fires once, after the preflight, with the clock's value;
- not called when the preflight fails;
- a throwing callback sends no request;
- abort before the run, during the preflight and during the plan;
- the settle bound on a fake clock;
- the steady and incident golden hashes unchanged.

## 4. Clocks, phases, lifecycles and deadlines

**Clocks.** [Proposed] Both are injected so tests can control them:

- One **wall clock**, `Date`, read in UTC with milliseconds. It stamps the manifest, the bundle ID and the report at the moment each event happens, and never controls timing.
- One **monotonic clock**, the `Clock` also passed to the load generator. Every deadline is an absolute monotonic time, `start + budget`, and every remaining time is `deadline − monotonic.now()`.

**The anchor T** [Proposed] is the `atMs` passed to `onPlanStart`: M4's preflight has passed and the plan has started. `window.loadStartedAt` is the wall clock read inside that callback. If the hook never fires, there is no T, no load window, and no bundle.

**Timer latency.** Node fires timers late when the event loop is busy. Every bound below is the time at which the CLI starts an abort or stops waiting. Work can end later by that latency, which this design does not bound (section 7).

### 4.1 Run phases

The run moves through these phases in order. The load-and-fault phase holds three concurrent lifecycles (4.2).

| Phase            | Starts                                        | Ends                                                                                    | Deadline          | On failure or timeout                    |
| ---------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------- |
| `CHECKS`         | CLI start                                     | config and isolation checks pass                                                        | 15 s              | exit 1; nothing to clean up              |
| `LOCK`           | checks pass                                   | lock created exclusively                                                                | 1 s               | exit 1                                   |
| `PREFLIGHT`      | lock acquired: **the global deadline starts** | preflight checks pass, the bundle ID is computed, and no collision is found (section 6) | 30 s              | cleanup (lock only), exit 1              |
| `LOAD_AND_FAULT` | `run()` is called                             | load settled, fault stopped or stop unconfirmed, detection finished                     | section 4.2       | cleanup, exit per section 9              |
| `FLUSH`          | load settled                                  | 15 s later                                                                              | 15 s              | —                                        |
| `CAPTURE`        | flush ends                                    | three captures succeed                                                                  | 120 s (section 7) | `.failed/`, exit 3                       |
| `WRITE`          | captures succeed                              | `writeBundle` returns                                                                   | 30 s              | `.failed/`, exit 3                       |
| `VALIDATE`       | written                                       | `validateBundle` returns                                                                | 30 s              | invalid bundle moved (section 6), exit 3 |
| `REPORT`         | validation done                               | final cleanup done, report emitted                                                      | cleanup bound     | —                                        |

Phases after `LOAD_AND_FAULT` run only when that phase ended with detection `DETECTED` or `NOT_DETECTED` and no orchestration failure (section 6, "No capture after an orchestration failure").

### 4.2 Concurrent lifecycles inside `LOAD_AND_FAULT`

Times are relative to T. The load plan, the fault lifecycle and detection run **concurrently**. Stopping the fault never stops or delays the load plan.

**Load lifecycle.**

| State           | Entered           | Deadline                                                   | On timeout or failure                         |
| --------------- | ----------------- | ---------------------------------------------------------- | --------------------------------------------- |
| `LOAD_STARTING` | `run()` called    | 30 s for `onPlanStart`, covering M4's preflight            | orchestration failure; abort the signal       |
| `LOAD_RUNNING`  | `onPlanStart` (T) | the plan's last entry is due at T+150 s                    | `run()` rejecting is an orchestration failure |
| `LOAD_SETTLED`  | `run()` resolves  | by T+160 s (T+150 plus the 5 s request timeout and margin) | orchestration failure; abort the signal       |

**Fault lifecycle.**

| State              | Entered                                                                                                   | Deadline                                              | On timeout or failure                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `NOT_STARTED`      | T                                                                                                         | the start is sent at T+30 s                           | if the run has already failed, the start is never sent                                                     |
| `STARTING`         | start request sent; **the scenario counts as possibly active from here**                                  | 10 s for the response (until T+40 s)                  | orchestration failure                                                                                      |
| `ACTIVE`           | 202 received (for `poison-order`, the order request follows, with a 5 s timeout)                          | the normal stop is sent at T+120 s                    | a failed poison order is an orchestration failure                                                          |
| `STOPPING`         | normal stop sent at T+120 s                                                                               | the stop procedure (4.3): at most 25 s, so by T+145 s | unconfirmed → `STOP_UNCONFIRMED`                                                                           |
| `STOPPED`          | the report shows no active scenario on either process; **the scenario stops counting as possibly active** | —                                                     | —                                                                                                          |
| `STOP_UNCONFIRMED` | the stop procedure ended without confirmation                                                             | —                                                     | `trigger.stoppedAt` stays `null`. The run continues; the final cleanup tries the stop procedure once more. |

**Detection lifecycle.**

| State     | Entered          | Deadline                                                                                                 | Ends as                                      |
| --------- | ---------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `WAITING` | T                | —                                                                                                        | —                                            |
| `POLLING` | the 202 response | until detected or T+150 s; a query every 5 s, each with a 4 s timeout so polls never overlap; no retries | `DETECTED`, `NOT_DETECTED` or `INCONCLUSIVE` |

- `DETECTED`: a poll returned a sample. Polling stops.
- `NOT_DETECTED`: every poll through T+150 s succeeded and returned a valid empty result.
- `INCONCLUSIVE`: the symptom was not detected and at least one poll failed: transport error, timeout, HTTP error or malformed response. A failed poll is never counted as an empty result.

**[Proposed, fail-closed]** Polls are not retried. The manifest's `detectedAt: null` means "not detected", and the schema has no way to express "unknown". So an undetected run with a failed poll is reported as `INCONCLUSIVE`, which is an orchestration failure. Retrying polls or tolerating transient failures is a possible future proposal, not part of this contract.

`LOAD_AND_FAULT` ends when all three are true:

1. the load is `LOAD_SETTLED`;
2. the fault is `STOPPED` or `STOP_UNCONFIRMED`;
3. detection has finished.

That is by T+160 s.

### 4.3 The stop procedure

One procedure serves both the normal stop and cleanup. [Proposed]

1. **Stop phase, 15 s:** `POST /admin/scenarios/stop` with a 7 s timeout. If it fails, pause 1 s, then try once more with a 7 s timeout. M5a's stop is idempotent.
2. **Confirm phase, 10 s:** `GET /admin/scenarios/active` once per second, each with a 2 s timeout, until both processes report none.

The whole procedure is bounded at 25 s. Confirmation, not the stop response, moves the fault to `STOPPED`.

### 4.4 The global deadline and the budget

**Global deadline.** [Proposed] 600 s on the monotonic clock from acquiring the lock. It is a hard deadline for normal work. When it passes, normal work is cancelled and the canonical cleanup (section 5) runs within its own 32 s bound.

**Normal worst case from the lock**, each step at its deadline:

| Step                                                                             | Seconds                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `PREFLIGHT`                                                                      | 30                                                          |
| `LOAD_STARTING`                                                                  | 30                                                          |
| T to load settled                                                                | 160                                                         |
| `FLUSH`                                                                          | 15                                                          |
| `CAPTURE`                                                                        | 120                                                         |
| `WRITE`                                                                          | 30                                                          |
| `VALIDATE`                                                                       | 30                                                          |
| Final cleanup (lock release; plus the stop procedure only if `STOP_UNCONFIRMED`) | ≤ 26                                                        |
| **Total**                                                                        | **≤ 441 s**, under the 600 s deadline, before timer latency |

A typical run takes about 4 to 5 minutes.

## 5. The canonical cleanup algorithm

[Proposed] This is the only cleanup. The tables and prose all refer to it. It runs on any handled failure, timeout, the global deadline, or the first SIGINT or SIGTERM, and at the end of a normal run, when it releases the lock and, if needed, retries an unconfirmed stop.

**Inputs:**

- `possiblyActive`: true from `STARTING` until `STOPPED`;
- `stopInProgress`: true while a stop procedure is running;
- `loadRunning`: true from `LOAD_STARTING` until `run()` settles.

**Steps:**

1. **Start at once and concurrently:**
   - **(a) Stop.**
     - If `stopInProgress`, keep the running procedure; don't start a new one.
     - Otherwise, if `possiblyActive`, start the stop procedure (4.3).
     - Otherwise there is nothing to stop.
   - **(b) Load cancellation:** if `loadRunning`, abort the load generator's signal and wait for `run()` to settle, bounded at 6 s.

   Neither waits for the other. Load cancellation never delays the stop request.

2. **Wait** for (a) within 25 s and (b) within 6 s. They run in parallel.
3. **Release the lock:** delete it only if it still holds this run's PID and start time. 1 s.
4. **Record** each step:
   - `stop`: `not needed`, `confirmed` or `unconfirmed`;
   - `load cancellation`: `not needed`, `settled` or `timed out`;
   - `lock`: `released`, `not owned` or `failed`.

**Cleanup result:**

- `succeeded` only if the stop is `not needed` or `confirmed`, the load is `not needed` or `settled`, and the lock is `released`;
- otherwise `failed`, naming the failed steps;
- `incomplete (interrupted)` if a second signal ends the process during cleanup (section 9). An unconfirmed stop is never reported as `confirmed`.

**Bound:** 25 s parallel, plus 1 s for the lock, plus 6 s of margin: **32 s**, before timer latency.

**No needless stops:**

- A failure before `STARTING` sends no stop.
- After `STOPPED`, cleanup never sends one, even if the load fails later. The confirmed stop is kept in the report and the manifest.
- A failure during `STOPPING` continues that same procedure.

**What cleanup cannot do.** Cleanup cannot be guaranteed after SIGKILL, a second signal, a host failure, or a loss of connectivity to the API. M5a's activation expiry (`durationMs`, 90 s) then ends the fault on its own. It is a backstop, not a guarantee of cleanup. A lock left behind is handled as a stale lock (section 8).

## 6. Bundle integration and evidence outcomes

**Ground truth and scenario.**

- [Existing] `buildGroundTruth(name, seed)` is written in canonical form, and the M5b validator checks it against `manifest.scenario`.
- [Proposed] The preflight compares the scenario's `version` from `GET /admin/scenarios`, served by the running image, with the CLI's `SCENARIOS[name].version`. A mismatch exits 1. This catches fault definitions that differ between the image and the checkout. It is not complete image provenance (section 13).

**Bundle ID: computed and checked before the load.** [Proposed] The order is:

1. `CHECKS`: configuration and local isolation pass.
2. `LOCK`: the run lock is acquired.
3. `PREFLIGHT`: the preflight checks pass, then the bundle ID is computed from the wall clock at that moment, `preflightAt`, as `<scenario>-<seed>-<preflightAt as YYYYMMDDTHHMMSSZ>`.
   - This is M5b's required `BUNDLE_ID` format. M5b fixes the timestamp's format, not which moment it records.
   - The ID is never suffixed or altered.
4. The CLI checks that neither `INCIDENTS_DIR/<bundleId>` nor `INCIDENTS_DIR/.failed/<bundleId>` exists.
5. If either exists, the run fails as an **orchestration failure (exit 1)** before `run()` is called. No load starts, no fault is sent, and cleanup only releases the lock.
6. Otherwise `run()` is called. T is recorded only when `onPlanStart` fires.
7. At write time, the M5b writer still refuses an existing target.

**Collision outcomes:**

| Case                                                         | Outcome                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Collision found at preflight                                 | orchestration failure, exit 1, before any load or fault; no evidence                       |
| Path appears after the preflight check, before writing       | the writer refuses: evidence failure, exit 3; evidence preserved under `.failed/` as below |
| `onPlanStart` never fires                                    | orchestration failure, exit 1; no T, no capture, no bundle, no `.failed/`                  |
| All `.failed/` candidates occupied while preserving evidence | evidence "not preserved"; the primary exit code is unchanged                               |

An existing bundle or file is never renamed, modified, overwritten or deleted.

**Manifest provenance.** [Proposed]

| Field                         | Source                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `schemaVersion`               | `SCHEMA_VERSION` from `@commerce/incident-bundle`                                          |
| `bundleId`                    | As above (`preflightAt`)                                                                   |
| `createdAt`                   | Wall clock when writing starts                                                             |
| `scenario`                    | The ground truth's name, version and seed                                                  |
| `window.loadStartedAt`        | Wall clock inside `onPlanStart`                                                            |
| `window.loadEndedAt`          | Wall clock when `run()` resolves                                                           |
| `window.captureFrom`          | `loadStartedAt`                                                                            |
| `window.captureTo`            | `loadEndedAt` + 15 s. Prometheus adds its own ±60 s margin (M5b).                          |
| `trigger.startedAt`           | Wall clock at the 202                                                                      |
| `trigger.stoppedAt`           | Wall clock when the normal stop is confirmed, or `null`                                    |
| `trigger.requestedDurationMs` | `90000`                                                                                    |
| `detection.detectedAt`        | Wall clock of the poll that first saw the symptom (`DETECTED`), or `null` (`NOT_DETECTED`) |
| `detection.latencyMs`         | `detectedAt − trigger.startedAt`, or `null`                                                |
| `detection.deadlineSeconds`   | The ground truth's `primarySymptom.deadlineSeconds`                                        |
| `producer.repository`         | `"commerce-platform"`                                                                      |
| `producer.commit`             | `git rev-parse HEAD`: the checkout, not necessarily the image                              |
| `producer.dirty`              | `git status --porcelain` is non-empty                                                      |
| `services[]`                  | See below                                                                                  |
| `infrastructure.images`       | Each service's `Image` from `docker compose ps --format json` (section 8)                  |
| `load`                        | `profile: "incident"`, the seed, `planHash`, and `runPrefix` from the `RunReport`          |
| `capture`                     | The three M5b capture summaries                                                            |
| `files`                       | Computed by the writer                                                                     |

**Service metadata.** [Proposed]

- For each service with traces in the bundle, `name`, `version` and `instanceId` come from the trace resource attributes `service.name`, `service.version` and `service.instance.id`. One entry per distinct combination.
- A service with no traces in the window takes its name and instance from the Prometheus `job` and `instance` labels in `metrics.jsonl`, which M3 maps from the same attributes. Its version is `"unknown"`, and the report warns about it.
- A service seen in neither is omitted, with a warning. If no service can be identified, the M5b schema rejects the manifest, which is an evidence failure.
- Nothing is inferred beyond these sources.

**Terms.** [Proposed]

- **Valid:** the bundle passes `validateBundle`.
- **Complete:** valid, `trigger.stoppedAt` is not `null`, and no capture records a truncation reason. A failed capture source never produces a bundle, so a bundle has no other kind of omission.
- **Run outcome:** `success`, `symptom_not_detected`, `orchestration_failure`, `evidence_failure` or `interrupted`, plus the cleanup result (section 9).

**Trace truncation.** [Proposed] A valid bundle with `slice_saturated` or `service_cap` is reported as "valid, trace evidence may be incomplete", naming the service and reason. Truncation alone does not change exit code 0 or 2.

**No capture after an orchestration failure.** [Proposed, deliberate decision] Once an orchestration failure occurs, the run stops normal work and captures nothing. That includes a failed load, a failed start or poison order, `INCONCLUSIVE` detection, the global deadline, and an interruption by signal. The load, fault or detection did not run as designed, so a bundle from it would describe an uncertain experiment as if it were a normal incident. The report then says `bundle: none` and `evidence: none (orchestration failure)`. This is never presented as an empty capture or as evidence collected.

**Preserving failed evidence (P3, option a).** [Proposed] When a capture source, redaction, the writer or validation fails, the CLI tries to preserve evidence under `INCIDENTS_DIR/.failed/`:

1. **Create `INCIDENTS_DIR/.failed/`** if missing. This is a non-exclusive `mkdir`, because the directory is shared by all runs.
2. **Create the run's directory with an exclusive `mkdir`.** Try `<bundleId>`, then `<bundleId>-2` through `<bundleId>-9`: at most nine candidates. These names are not bundle IDs, so the suffix is safe. If all nine exist, or creation fails for another reason, **evidence is not preserved**. The report says so, with the error, and nothing is written.
3. **Write each file with an exclusive create (`wx`):**
   - the JSONL records of each capture that completed, under the bundle's file names;
   - `capture-summary.json`;
   - `failure.json`, last.

   A file that fails to write is listed as failed. The files already written are left in place.

4. **Report exactly the files that were written:**
   - `preserved <path> (<files>)` when all were written;
   - `partially preserved <path> (<written>; failed: <files>)` when some were;
   - `not preserved (<error>)` when none were.

`failure.json` is a CLI record, not part of the bundle contract. It is redacted like the records:

```json
{
  "failureVersion": 1,
  "bundleId": "…",
  "stage": "capture-metrics | capture-traces | capture-logs | redact | write | validate",
  "category": "transport | http | malformed-response | timeout | deadline | command | filesystem | validation",
  "message": "redacted error text",
  "occurredAt": "ISO 8601",
  "completedCaptures": ["metrics"],
  "files": ["metrics.jsonl", "capture-summary.json"]
}
```

A `.failed/` directory never contains `manifest.json` at its top level. It is never a bundle, and the report never calls it valid or complete. Nothing in `INCIDENTS_DIR` is ever overwritten or deleted.

**Validation failure after writing.** [Proposed] The writer has renamed the bundle into `INCIDENTS_DIR/<bundleId>`. The CLI:

1. leaves the bundle's files unchanged;
2. creates a `.failed/` candidate exactly as above;
3. renames `INCIDENTS_DIR/<bundleId>` to `<candidate>/bundle`, which doesn't exist yet, so nothing is overwritten;
4. writes `failure.json`, with stage `validate` and the validator's errors, next to it.

If step 2 or 3 fails, the bundle stays at `INCIDENTS_DIR/<bundleId>` untouched, and the report gives that actual location. Either way the bundle is reported as **invalid**. The exit code is 3.

## 7. Telemetry capture and retry budgets

[Proposed] Captures run in sequence: metrics, then traces, then logs. The M5b clients are unchanged. The CLI passes them a wrapped `fetch` and `runCommand` from `budget.ts`.

**Deadlines.** When a source starts, its deadline is `sourceDeadline = monotonic.now() + D_src`. Its effective deadline is `effective = min(sourceDeadline, globalDeadline)`. At any moment, `remaining = effective − monotonic.now()`.

**One request through the wrapped `fetch`:**

1. **Before an attempt:** if `remaining ≤ 0`, reject at once with `timeout` (source deadline) or `deadline` (global deadline). No attempt starts.
2. **Attempt:** the attempt gets `AbortSignal.any([attemptTimer, sourceSignal, globalSignal, interruptSignal])`, where `attemptTimer` fires after `min(t_attempt, remaining)`.
   - `sourceSignal` fires at `sourceDeadline`, and `globalSignal` at the global deadline, both via the injected timers.
   - The M5b clients pass no options to `fetch`, so the wrapper adds this signal itself. It also covers reading the response body.
3. **After a retryable failure,** another attempt starts only if all hold:
   - fewer than 3 attempts have been made;
   - `remaining ≥ pause + minAttempt`, where `pause = 2 s` and `minAttempt = 1 s`.

   If they hold, the wrapper waits the 2 s pause, then starts the next attempt with a fresh `remaining`. Otherwise the request fails with the last failure's category.
   - `minAttempt` is **only a scheduling guard**, not elapsed work. It stops the wrapper from pausing for 2 s and then starting an attempt with less than a second left. The pause happens only when an attempt will follow.

4. **Deadline reached:** the combined signal aborts the in-flight attempt or pause, and the wrapper rejects. A source deadline gives `timeout`. A global deadline gives `deadline`, and the run moves to cleanup as an orchestration failure. A signal gives `interrupted`. None of these is retried.

**`runCommand` wrapper (logs).** Each command gets a timeout of `min(15 s, remaining)`. When it fires, the process is sent SIGKILL and the wrapper rejects with `timeout` without waiting further. If the OS has not reaped the process yet, the report notes it. Commands are not retried.

**Classification:**

| Result                                                                                          | Retryable   | Category                         |
| ----------------------------------------------------------------------------------------------- | ----------- | -------------------------------- |
| Valid empty result: Prometheus `seriesCount: 0`, Jaeger 404 "No traces found", empty log output | — (success) | [Existing] valid                 |
| Connection refused or reset, DNS failure                                                        | yes         | `transport`                      |
| Attempt timer fired                                                                             | yes         | `timeout`                        |
| HTTP 502, 503 or 504                                                                            | yes         | `http`                           |
| Any other non-success status, including 4xx, other 5xx, and a 404 without "No traces found"     | no          | `http`                           |
| Payload that fails the client's Zod schema, or isn't JSON                                       | no          | `malformed-response`             |
| `docker compose logs` non-zero exit                                                             | no          | `command`                        |
| Source deadline                                                                                 | no          | `timeout` (source fails)         |
| Global deadline                                                                                 | no          | `deadline` (run goes to cleanup) |
| SIGINT or SIGTERM                                                                               | no          | `interrupted`                    |

**Per-source arithmetic.**

| Source                                  | `D_src`                      | `t_attempt` | Max attempts per request | Worst case for one request: attempts + pauses | Source bound             |
| --------------------------------------- | ---------------------------- | ----------- | ------------------------ | --------------------------------------------- | ------------------------ |
| Prometheus, 15 requests                 | 40 s                         | 10 s        | 3                        | 3 × 10 + 2 × 2 = **34 s**                     | 40 s for all 15 requests |
| Jaeger, ~36 base requests plus halvings | 50 s                         | 15 s        | 3                        | 3 × 15 + 2 × 2 = **49 s**                     | 50 s for all requests    |
| Docker logs, 2 commands                 | 15 s per command, 30 s total | 15 s        | 1                        | **15 s**                                      | 30 s                     |

The total is 120 s, matching `CAPTURE`.

- **Per-request worst case:** at most `min(effective, 3 × t_attempt + 2 × 2 s)` after the request starts.
- **Per-source bound:** every request shares one deadline, so each source ends by its effective deadline. When a slow request uses most of the budget, later requests get less, and the source fails with `timeout` if it runs out.

**What is guaranteed:**

- no attempt and no pause starts after the effective deadline;
- every in-flight attempt is signaled at the effective deadline, through the injected timers;
- the source rejects at that moment, so no retry can extend past it.

Actual completion can trail the deadline by event-loop and timer latency, and by abort propagation inside `fetch`. This design does **not** bound that latency, so the arithmetic above is exact only on a fake clock. Unit tests verify the deadline logic exactly with fake timers.

**Truncation.** [Existing] Jaeger slices of 10 s with `query.searchDepth=1000`, halved down to 1 s, at most 5,000 traces per service, deduplicated. [Proposed] The report lists each service's trace count and any truncation reasons.

**Not verified.** The M5b clients are tested only against stubs, and the Jaeger stub follows the v2.22.0 source. Live Jaeger, Prometheus and Docker output have never been exercised. If Jaeger is slow, the base requests plus halvings could exhaust 50 s. That is an evidence failure, not truncation [Open, section 14].

## 8. Runtime, isolation and safety

### 8.1 Build, invocation and configuration

- [Existing] The root build compiles `apps/incident`; the Dockerfile copies it into the build stage only.
- [Proposed] Add `src/main.ts` and `src/cli.ts`, and a root script: `"incident": "node --env-file-if-exists=.env apps/incident/dist/main.js"`.
- [Proposed] `apps/incident` gains workspace dependencies on `@commerce/faults` and `@commerce/loadgen`. No new external dependency is added.

| Variable         | Default for `pnpm incident`  | Status                                                                                                                |
| ---------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ORDERS_API_URL` | `http://127.0.0.1:3000`      | [Existing] name, from M4. [Proposed] The incident CLI uses an IP-literal default; loadgen's own default is unchanged. |
| `JAEGER_URL`     | `http://127.0.0.1:16686`     | [Existing] name, from the M3 e2e scripts                                                                              |
| `PROMETHEUS_URL` | `http://127.0.0.1:9090`      | [Existing] name, from the M3 e2e scripts                                                                              |
| `INCIDENTS_DIR`  | `incidents` (ignored by Git) | [Proposed]                                                                                                            |

The values are validated with Zod at startup. An invalid value exits 1 and names the variable.

### 8.2 Local isolation (P5)

[Proposed] Every check must pass before the lock is taken. A check that cannot run, gets unparseable output, or finds an ambiguous mapping fails the run with exit 1. Missing metadata never relaxes a check.

1. **URL form.** Each service URL uses `http:`, and its host is the IP literal `127.0.0.1` or `[::1]`. Hostnames, including `localhost`, are rejected: a name can resolve to both IPv4 and IPv6, and the address used could be one Docker doesn't publish.
2. **Local Docker.** `DOCKER_HOST` is unset or uses a `unix://` or `npipe://` endpoint, and `docker context inspect` for the current context reports such an endpoint.
3. **Project selection.**
   - `compose.yaml` fixes the project name to `commerce-platform`. `COMPOSE_PROJECT_NAME` must be unset or equal to it.
   - `docker compose ps --format json`, run from the repository root, must return only containers whose `Project` is `commerce-platform`.
   - It must list exactly one running container each for `orders-api`, `worker`, `jaeger`, `prometheus` and `otel-collector`.
   - `orders-api` and `worker` must report healthy.
4. **URL-to-service mapping.**
   - For each URL, exactly one publisher of the expected service (`orders-api`, `jaeger`, `prometheus`) must have a host IP equal to the URL's IP literal and a published port equal to the URL's port.
   - No other service in the project may publish that IP and port.
   - Missing publisher data, or zero or more than one match, fails the run.
5. **Fault controls on loopback.** Every publisher of `orders-api` and `worker` must be bound to `127.0.0.1` or `::1`. Any `0.0.0.0`, `::` or other address fails, including when a loopback publisher also exists.

**What these checks do not prove.**

- Matching a URL to a published port does **not** prove that the CLI's traffic reaches the intended container. It shows only that Docker publishes that address for that container. For example, Docker Desktop on macOS forwards published ports through its own process, and the repository has no evidence about other listeners or firewall rules.
- **[Open] Identity cross-check, proposed:** compare the Prometheus `instance` label for `job="orders-api"` with the `orders-api` container's ID prefix from `docker compose ps`.
  - The repository shows that `orders-api` sets `service.instance.id` to `hostname()`, and that Compose sets no hostname.
  - Whether `hostname()` inside the container equals the container's short ID is **not evidenced** and must be verified.
- **Live runs stay blocked** until container integration either verifies this cross-check or establishes an equally strong alternative that the owner approves.

**Expected `docker compose ps --format json` data.** [Open]

- Per container: `ID`, `Service`, `Project`, `Image`, `State`, `Health`, and `Publishers`, a list of `{ URL, TargetPort, PublishedPort, Protocol }`, where `URL` is the host IP.
- The parser accepts either one JSON object per line or a JSON array, validated with Zod. Any other shape fails the run.
- The real shape on the local Compose v5.4.0 is **unverified**.

**`compose.faults.yaml`.**

- [Existing] It sets `FAULTS_ENABLED=true` for both apps and `WORKER_ADMIN_URL=http://worker:3001` for the API. The base `compose.yaml` doesn't change, and no new service is added.
- [Proposed] It must bind the API and worker ports to loopback.
- [Open] The proposed mechanism is Compose's `!override` tag, for example `ports: !override ["127.0.0.1:3000:3000"]`. Its local support is untested. Without it, check 5 fails and no run starts.

### 8.3 `capture-check`

[Proposed] `pnpm incident capture-check` is a non-destructive preflight. It runs the checks below and reports each one. It never:

- activates or stops a fault scenario;
- starts or stops services;
- runs a load profile;
- writes a bundle, a `.failed/` directory or the run lock;
- creates, deletes or overwrites any file.

| Check                                                  | How                                                                                                                                                     | Implementable from existing source and config | Needs container integration to trust                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| Configuration and URL form (8.2, check 1)              | Zod, IP-literal rule                                                                                                                                    | yes                                           | —                                                    |
| Local Docker (check 2)                                 | `DOCKER_HOST`, `docker context inspect`                                                                                                                 | yes                                           | output shape                                         |
| Project, services, single containers, health (check 3) | `docker compose ps --format json`                                                                                                                       | parser written from the expected shape        | **yes**: real shape [Open]                           |
| URL-to-service mapping (check 4)                       | publishers versus URLs                                                                                                                                  | logic                                         | **yes**: `Publishers` shape [Open]                   |
| Fault-control loopback binding (check 5)               | publishers of `orders-api` and `worker`                                                                                                                 | logic                                         | **yes**: real bindings [Open]                        |
| Compose capability for the loopback override           | `docker compose -f compose.yaml -f compose.faults.yaml config --format json`, read-only; checks that it parses and that the resolved ports are loopback | command                                       | **yes**: `!override` support and output shape [Open] |
| Identity cross-check (8.2)                             | Prometheus `instance` versus container ID                                                                                                               | logic                                         | **yes** [Open]                                       |
| API connectivity                                       | `GET /readyz` returns 200; `GET /admin/scenarios` returns 200 or 404, reported as "faults enabled" or "faults disabled"                                 | yes                                           | —                                                    |
| Prometheus and Jaeger readiness                        | `GET /-/ready`; Jaeger UI root returns 200                                                                                                              | yes                                           | —                                                    |
| Output location                                        | `fs.access(INCIDENTS_DIR, W_OK)`; if it is missing, the nearest existing parent is checked; nothing is created                                          | yes                                           | —                                                    |
| Free disk                                              | `fs.statfs`, at least 1 GiB                                                                                                                             | yes                                           | —                                                    |

**Result of each check:**

- `PASS`;
- `FAIL`: the check ran and the condition is false;
- `INCONCLUSIVE`: the check could not run, its output was unparseable, or it depends on an [Open] item not yet verified.

**Output:** one line per check, `PASS | FAIL | INCONCLUSIVE <check>: <detail>`, then one summary line.

**`capture-check` exit codes:**

- `0`: every check passed;
- `1`: at least one `FAIL`;
- `5`: no `FAIL`, but at least one `INCONCLUSIVE`.

These codes belong to `capture-check` only. It fails closed: a safety-critical check that is `INCONCLUSIVE` never yields 0. Until container integration verifies the [Open] items, those checks report `INCONCLUSIVE`, so `capture-check` cannot pass.

### 8.4 Redaction, locking, resources and stock

**Secrets and redaction.** [Proposed]

- Before anything is written, either to a bundle or to `.failed/`, the password in any `postgres://` or `postgresql://` URL in log messages, log attributes, span attribute values and failure messages is replaced with `***`.
- The values of attributes named `authorization`, `cookie` or `set-cookie` are replaced with `***`.
- The CLI never reads secrets into a bundle. The apps don't log `DATABASE_URL` today; this is a guard.
- **P4 deferred:** the redaction count appears only in the report.

**Locking.** [Proposed]

- **Acquire:** `INCIDENTS_DIR/.incident.lock` is created with an exclusive create (`wx`). It holds the PID, hostname, start time, scenario and seed.
- **Held:** if the lock exists and its PID is alive on this host, the run exits 1 with "another run is in progress".
- **Stale:** if its PID is not alive, or its hostname differs, the run exits 1, prints the lock's contents, and asks the operator to check that `GET /admin/scenarios/active` shows no scenario before removing the file.
  - The CLI never removes a stale lock itself. A stale lock means a run ended without cleanup, so a fault may still be active, and evidence may need inspection.
  - The PID may also have been reused, so liveness alone isn't proof.
- **Release:** only by the owning run.
- **Second guard:** M5a's 409 for a second start.

**Resources.** [Proposed]

- One run at a time.
- The 600 s global deadline plus the 32 s cleanup bound, before timer latency.
- At most 10,000 traces in memory: 5,000 per service, for two services.
- At least 1 GiB free in `INCIDENTS_DIR` at preflight.

**Retention.** Bundles and `.failed/` directories are never deleted automatically. The report prints their count and total size, and states that nothing is deleted automatically. It makes no claim about which bundles are safe to remove.

**Stock.** [Existing] M4's preflight stops a run when planned stock is short by more than 5% for any SKU. `provider-outage` leaves orders in `payment_unknown`, holding stock, for up to 15 minutes after a run (`PAYMENT_UNKNOWN_RECHECK_MS`). Back-to-back runs can fail the stock preflight sooner than the stock totals suggest.

**Run preflight** (phase `PREFLIGHT`). [Proposed]

- The orders API's `/readyz` returns 200.
- `GET /admin/scenarios` returns 200, so faults are enabled, and its scenario version matches the CLI's.
- `GET /admin/scenarios/active` shows no active scenario.
- Prometheus `/-/ready` and Jaeger's UI root return 200.
- `git rev-parse HEAD` works.
- At least 1 GiB of free disk.
- Then the bundle ID and the collision check (section 6).

## 9. Run outcomes, exit codes, signals and the failure table (P7)

**Primary outcome and code.** [Proposed]

| Primary outcome                                      | Code       |
| ---------------------------------------------------- | ---------- |
| `success`: valid bundle, `DETECTED`                  | 0          |
| `symptom_not_detected`: valid bundle, `NOT_DETECTED` | 2          |
| `orchestration_failure`                              | 1          |
| `evidence_failure`                                   | 3          |
| `interrupted`: the first SIGINT or SIGTERM           | 130 or 143 |

**Final code.** One rule: a cleanup failure replaces only the non-failure codes, 0 and 2. A failure code stays primary, and the cleanup failure is reported as secondary.

| Primary    | Cleanup `succeeded` | Cleanup `failed`                      | Second signal during cleanup     |
| ---------- | ------------------- | ------------------------------------- | -------------------------------- |
| 0          | 0                   | **4**                                 | 130 or 143 (the second signal's) |
| 2          | 2                   | **4**                                 | 130 or 143 (the second signal's) |
| 1          | 1                   | 1, cleanup failure secondary          | 130 or 143 (the second signal's) |
| 3          | 3                   | 3, cleanup failure secondary          | 130 or 143 (the second signal's) |
| 130 or 143 | 130 or 143          | 130 or 143, cleanup failure secondary | the first signal's code          |

**Why signals keep their codes.** A shell or supervisor that sent the signal expects the conventional 128 + N. Replacing it with 4 would hide that the run was interrupted on purpose. A cleanup failure after a signal is never hidden: it is reported in the `cleanup:` line, as long as the report can be emitted (below).

**Signals and report emission.** [Proposed]

- **First SIGINT or SIGTERM:** normal work is cancelled, and the canonical cleanup runs within its bound. The report is then emitted, and the process exits with the code above.
- **Second signal during cleanup:** the CLI may end cleanup at once. It makes one best-effort, synchronous write of a single line to stderr, `interrupted during cleanup: cleanup incomplete`, then exits immediately. Whatever cleanup steps had finished are not reported as succeeded. M5a's 90 s activation expiry remains the backstop for an active fault, and the lock may be left behind as a stale lock.
- **Report states.** The report is built in memory during the run, then **emitted** by writing it to stdout.
  - It is emitted only when that write completes.
  - The CLI writes no report file, so a report is never "persisted" beyond stdout.
  - If the write fails, or the process ends first, as after a second signal, SIGKILL or a closed pipe, the report was **not emitted**. Nothing may assume it exists, or that its cleanup status was recorded.
  - Reading stdout, or redirecting it to a file, is the caller's job.

**Measurements.** Before the warnings' end, the report prints `measurement:` lines: each capture source's duration, request attempts and budget; trace volume per service; and detection latency or "not detected". They are report-only evidence for open item 4.

**The emitted report ends with four lines:**

```text
outcome: success | symptom_not_detected | orchestration_failure (<stage>) | evidence_failure (<stage>) | interrupted (<signal>)
bundle: valid <path> | invalid <path> | none
evidence: complete | incomplete (<reasons>) | preserved <path> (<files>) | partially preserved <path> (<files>) | not preserved (<error>) | none (<reason>)
cleanup: succeeded | failed (<steps>)
```

**Failure table.** [Proposed] "Cleanup" always means the canonical algorithm (section 5). The table shows what it does in each case.

| Failure                                                                                         | Primary              | Code before cleanup           | Bundle and evidence                                                       | Stop sent by cleanup?                      |
| ----------------------------------------------------------------------------------------------- | -------------------- | ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| Invalid config or arguments; an isolation check fails or cannot run                             | orchestration        | 1                             | none                                                                      | no lock, no cleanup                        |
| Lock held or stale                                                                              | orchestration        | 1                             | none                                                                      | no cleanup                                 |
| A preflight check fails or times out; scenario version mismatch                                 | orchestration        | 1                             | none                                                                      | no; lock released                          |
| Bundle-ID collision at preflight                                                                | orchestration        | 1                             | none                                                                      | no; lock released; no load was started     |
| M4 preflight fails, `run()` rejects, or `onPlanStart` misses its 30 s                           | orchestration        | 1                             | none                                                                      | no; load cancelled                         |
| Load fails during `LOAD_RUNNING`, before T+30 s                                                 | orchestration        | 1                             | none                                                                      | no; load cancelled                         |
| Start returns 409, 404, 400, 502 or 503, or times out                                           | orchestration        | 1                             | none                                                                      | yes (possibly active); load cancelled      |
| Poison order fails                                                                              | orchestration        | 1                             | none                                                                      | yes; load cancelled                        |
| Load fails or misses T+160 s while the fault is `ACTIVE` or `STOPPING`                          | orchestration        | 1                             | none                                                                      | yes, or continues the running procedure    |
| Load fails or misses T+160 s after `STOPPED`                                                    | orchestration        | 1                             | none                                                                      | no; the confirmed stop is kept             |
| Detection `INCONCLUSIVE` (any failed poll, symptom not seen)                                    | orchestration        | 1                             | none (no capture)                                                         | per fault state                            |
| Detection `NOT_DETECTED`, everything else succeeds                                              | symptom not detected | 2                             | valid bundle, `detectedAt: null`                                          | only if `STOP_UNCONFIRMED`                 |
| A capture source fails or exceeds its budget                                                    | evidence             | 3                             | `.failed/` as written                                                     | only if `STOP_UNCONFIRMED`                 |
| Redaction or writer failure, including a path that appeared after the preflight collision check | evidence             | 3                             | `.failed/` as written                                                     | only if `STOP_UNCONFIRMED`                 |
| Validator reports errors                                                                        | evidence             | 3                             | invalid bundle moved to `.failed/…/bundle`, or left in place, as reported | only if `STOP_UNCONFIRMED`                 |
| All `.failed/` candidates occupied                                                              | unchanged (3)        | 3                             | not preserved                                                             | as for the row that caused it              |
| Global deadline                                                                                 | orchestration        | 1                             | none                                                                      | per fault state; load cancelled if running |
| First SIGINT or SIGTERM                                                                         | interrupted          | 130 or 143                    | none                                                                      | per fault state; load cancelled if running |
| Second signal during cleanup                                                                    | as the first signal  | 130 or 143                    | none                                                                      | cleanup ended early; result incomplete     |
| Normal stop `STOP_UNCONFIRMED` and the final cleanup also fails to confirm                      | the run's primary    | then per the final-code table | as for the primary                                                        | yes, once more                             |

A mismatched manifest and ground truth can only arise from a bug, because both come from the same scenario values. The validator would report it as an evidence failure.

## 10. Acceptance criteria and test layers

[Existing] C1 to C6 in `m5-design.md` stay as written. [Proposed] New criteria, labeled proposed until the owner approves this design:

- **C7** [D] **Local isolation.** Each check in section 8.2 fails closed:
  - a hostname such as `localhost`, an `https:` URL or a non-loopback IP;
  - a remote Docker context or a non-local `DOCKER_HOST`;
  - a different `COMPOSE_PROJECT_NAME`, a container from another project, a missing service, or two containers for one service;
  - an unhealthy app;
  - no, or several, matching publishers;
  - any non-loopback publisher on `orders-api` or `worker`;
  - unparseable `compose ps` output.

  `capture-check` reports `FAIL` or `INCONCLUSIVE` with exit 1 or 5 for each, never 0.

- **C8** [D] **Locking.** Exclusive creation; held and stale locks exit 1 without removing the file; release only by the owning run.
- **C9** [D] **Redaction.** Database URL passwords and the named attribute values are redacted in logs, spans and `failure.json`. The count is reported, and the schema is unchanged.
- **C10** [D] **Detection.** Each scenario's primary-symptom condition, taken from M5a's committed golden ground truths, renders to the expected PromQL. A returned sample is `DETECTED`. All-empty polls give `NOT_DETECTED` (exit 2). One failed poll with no detection gives `INCONCLUSIVE` (exit 1, no capture). A transport failure is never counted as empty.

**Layers.**

1. **Deterministic unit tests, proposed for CI.** Fake wall and monotonic clocks, injected fetch, command runner, file system and signals. They cover:
   - C1, C2 and C7 to C10;
   - the P1 hook tests (section 3);
   - every phase and lifecycle transition in section 4, including each deadline;
   - the concurrent load, fault and detection timeline, including the stop at T+120 s not affecting the load;
   - the cleanup algorithm: no needless stop, continuing a running stop, stop and load cancellation concurrent, release only by the owner;
   - every row of the section 9 tables, including a first and second signal, and a stdout write that fails;
   - the bundle-ID preflight check, a path appearing before the write, and nine-candidate exhaustion;
   - `wx` writes and partial or failed preservation;
   - the move of an invalid bundle and its failure;
   - the retry wrapper: the attempt condition, the scheduling guard, aborts at the source and global deadlines, the classification table, and that no attempt starts after a deadline;
   - `capture-check`: every check's `PASS`, `FAIL` and `INCONCLUSIVE` path and its exit codes, and that it never writes files.

   Coverage stays at 80% lines per file, with `apps/incident/src/**` already enforced. The `steady` profile and its golden hash don't change.

2. **Container integration, needs separate explicit approval.**
   - `docker compose build`, which would be the first build with the M5a and M5b Dockerfile changes.
   - Starting the stack with `compose.faults.yaml`.
   - Recording the real `docker compose ps --format json` and `docker compose config --format json` shapes.
   - Confirming the loopback publishers and `!override` support.
   - Testing the identity cross-check, or an alternative.
   - **Evidence:** command output, recorded in the review.
3. **`capture-check` against the running stack, needs separate explicit approval.** Read-only. Its results are reviewed before any live run.
4. **Live fault runs, each needs separate explicit approval.** These are blocked until layer 2 has verified the identity cross-check or an approved alternative, the `ps` shape and the loopback binding, and until `capture-check` passes.
   - C3, C3a, C3b, C4 and C5 as in `m5-design.md`: the five scenarios with seed 42, then a second run of each.
   - That is about 3,750 orders and 11,000 units of stock.
   - Stock is checked first, and cleanup is confirmed after each run.
   - The first authorized run also yields the real trace volume and Jaeger capture time [Open item 4].
5. **CI.** Deterministic tests only: `pnpm format:check`, `lint`, `typecheck`, `test:coverage` and `test:smoke`. Results must be confirmed in GitHub Actions; this design claims none.

## 11. Module interfaces

[Proposed] Signatures are illustrative; the implementation review settles the exact types.

```ts
// run.ts
interface RunDeps {
  wallClock: () => Date;
  monotonic: { now(): number };
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
  fetch: HttpFetch; // wrapped per section 7
  runCommand: RunCommand; // wrapped, with a timeout and SIGKILL
  fs: BundleFs & EvidenceFs;
  signals: { onSignal(handler: (signal: 'SIGINT' | 'SIGTERM', count: number) => void): void };
  createLoadGenerator: typeof createLoadGenerator;
}
interface RunReport {
  outcome:
    | 'success'
    | 'symptom_not_detected'
    | 'orchestration_failure'
    | 'evidence_failure'
    | 'interrupted';
  stage?: string;
  signal?: 'SIGINT' | 'SIGTERM';
  bundle: { state: 'valid' | 'invalid' | 'none'; path?: string };
  evidence: {
    state:
      'complete' | 'incomplete' | 'preserved' | 'partially_preserved' | 'not_preserved' | 'none';
    path?: string;
    files?: string[];
    reasons?: string[];
  };
  cleanup: {
    state: 'succeeded' | 'failed' | 'incomplete';
    steps: { step: 'stop' | 'load' | 'lock'; result: string }[];
  };
  warnings: string[];
}
function runIncident(config: RunConfig, deps: RunDeps): Promise<RunReport>;
function exitCodeFor(report: RunReport): number; // section 9
function captureCheck(
  config: CheckConfig,
  deps: CheckDeps,
): Promise<{ checks: CheckResult[]; exitCode: 0 | 1 | 5 }>;
```

## 12. Implementation plan

[Proposed] Order:

1. The owner reviews and approves this contract.
2. Load-generator hooks (section 3) and their unit tests.
3. `config.ts`, `isolation.ts`, `lock.ts` and `redact.ts`, with unit tests.
4. `control.ts`, `detect.ts`, `metadata.ts` and `budget.ts`, with unit tests.
5. `evidence.ts` and `run.ts`: phases, lifecycles, the cleanup algorithm and outcomes.
6. `cli.ts` and `main.ts`: `list`, `ground-truth`, `validate`, `run` and `capture-check` (section 8.3), plus the root `incident` script.
7. `compose.faults.yaml` with the loopback port binding.
8. Docs: README, roadmap, architecture and the M5 design status. Then the deterministic local gates: `pnpm format:check`, `lint`, `typecheck`, `build`, `test:coverage`, `test:smoke` and `git diff --check`.
9. The implementation diff, presented for review.
10. Separate approval for container integration (layer 2), then `capture-check` against the stack (layer 3), then each live fault run (layer 4), which is possible only after layers 2 and 3 settle the safety-critical [Open] items.

## 13. Decisions recorded

| Item                                   | Decision in this proposal                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 load-generator hooks                | Included (section 3)                                                                                                                                                                   |
| P2 bundle when the symptom is absent   | `NOT_DETECTED`: exit 2 with `detectedAt: null` and a normal bundle                                                                                                                     |
| Symptom polling                        | Fail-closed: no poll retries; any failed poll with no detection is `INCONCLUSIVE`, exit 1, no bundle                                                                                   |
| Capture after an orchestration failure | Deliberately none (section 6)                                                                                                                                                          |
| P3 capture failure                     | Option (a): `.failed/`, collision-safe and truthful; no schema change                                                                                                                  |
| P4 redaction count                     | Deferred: report only                                                                                                                                                                  |
| P5 local-only fault controls           | Fail-closed checks 1 to 5. Live runs blocked until container integration verifies the identity cross-check or an approved alternative.                                                 |
| P6 OCI revision label                  | Deferred. `producer.commit` identifies the checkout, which may differ from the running image's commit; the scenario-version check is not complete image provenance.                    |
| P7 criteria and exit codes             | C7 to C10 and the section 9 tables, proposed                                                                                                                                           |
| Bundle-ID collision                    | Computed and checked at preflight, before any load or fault; the writer's refusal covers later races; IDs are never suffixed                                                           |
| Signals                                | Conventional 130 and 143. A second signal may cut cleanup short, and its result is then incomplete. The report is emitted to stdout only, and is not guaranteed after a second signal. |
| `capture-check`                        | Non-destructive preflight with `PASS`, `FAIL` and `INCONCLUSIVE`, exit codes 0, 1 and 5, fail-closed                                                                                   |

None of these changes the M5b contract or ADR 0007. Schema changes such as P3 option (b) or P4 stay future proposals.

## 14. Risks and open questions

**Risks.**

- [Existing] Bundle size, Jaeger memory growth across runs, host timing variance, and stock use.
- [Existing] Stock held by `provider-outage` for up to 15 minutes.
- [Proposed] Image drift beyond the scenario version goes undetected (P6 deferred).
- [Proposed] A failed run keeps no telemetry after an orchestration failure (deliberate).
- [Proposed] Fail-closed polling turns one failed poll into exit 1 if the symptom is never seen.
- [Proposed] Timer latency means actual completion can trail the stated bounds, which are not hard real-time.

**Assumptions.** The stack runs on the same host as the CLI. `docker compose` is run from the repository root. The Compose service names are `orders-api`, `worker`, `jaeger`, `prometheus` and `otel-collector`.

**Open items**, all safety-critical except item 4. Items 1 to 3 were verified on 2026-10-25 and accepted by the owner (results below); item 4 is unverified.

| #   | Question                                                                                                                                                                                                                        | Verification needed                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | The real `docker compose ps --format json` output, including `Publishers`, and the parser's behavior on it, on the local Compose v5.4.0                                                                                         | container integration (layer 2), recorded output |
| 2   | Support for the `!override` loopback binding in `compose.faults.yaml`, and the resolved ports from `docker compose config --format json`                                                                                        | container integration (layer 2)                  |
| 3   | Whether `hostname()` inside the `orders-api` container equals its short container ID, so the Prometheus `instance` label can be matched against `docker compose ps`; otherwise an equally strong alternative the owner approves | container integration (layer 2), then the owner  |
| 4   | Real trace volume per slice, and Jaeger's capture time against the 50 s budget                                                                                                                                                  | the first authorized live fault run (layer 4)    |

**Verification results, 2026-10-25** (Docker 29.7.2, Docker Compose v5.4.0, Docker Desktop):

- **Item 1, verified.** Real `docker compose ps --format json` output is one JSON object per line, with `ID` (12-character short ID), `Service`, `Project`, `Image`, `State`, `Health` (empty when a service has no healthcheck) and `Publishers` (`URL` is the host IP). The parser reads it; truncated lines, missing fields, duplicate containers and foreign projects fail closed.
- **Item 2, verified for configuration and at runtime.** `docker compose -f compose.yaml -f compose.faults.yaml config --format json` resolves one port each for `orders-api` and `worker`, with `host_ip: 127.0.0.1`; without `!override` the base ports are appended instead. After `up -d --no-deps --no-build --pull never --wait orders-api worker`, `docker compose ps`, `docker inspect` and the host's listening sockets show only `127.0.0.1:3000` and `127.0.0.1:3001`.
- **Item 3, verified for the API premise only.** The `orders-api` container's hostname, its `ps` ID and the Prometheus `instance` label are the same short ID. Limitations accepted by the owner: this does not prove the CLI's HTTP traffic reaches that container (Docker Desktop forwards published ports through its own process); the worker's `instance` is `WORKER_ID` (`worker-1`), not its container ID; Jaeger is not tied to the project. Just after a recreation, Prometheus briefly shows the old and the new instance, so the check fails until the old series goes stale.
- **Item 4, unverified.** It needs an authorized live run. The report now measures it: a `measurement:` line per capture source gives its duration on the monotonic clock, with retries and request attempts; one per service gives trace volume, saturated slices and truncation; one gives detection latency. The bundle schema is unchanged.

**Blocking findings, resolved on 2026-10-25:**

1. The URL-mapping check failed for `JAEGER_URL` and `PROMETHEUS_URL`, because Jaeger and Prometheus were published on `0.0.0.0` and `::`. `compose.faults.yaml` now binds them to `127.0.0.1` with `!override`, as for the API and worker; the check itself is unchanged.
2. The running image predated M5a. It was rebuilt from the working tree, its fault package, admin modules and five scenarios checked in a throwaway container with no network, and the API and worker recreated from it.

Before Jaeger was recreated, its in-memory traces (4,177 for `orders-api`, 949 for `worker`, all under the 10,000 search limit) were exported read-only through its v3 API into a local file outside the repository; Jaeger's store is empty after the recreation. Prometheus kept its data: Compose reused its anonymous `/prometheus` volume.

After the recreation, Prometheus showed the old and the new `orders-api` instance, so the identity check failed, as designed, until the old series went stale; only then did all six isolation checks pass.

**Remaining exposure, outside the isolation checks:** `otel-collector` (4318, 13133) and `postgres` (5432) keep the base file's all-interface bindings.

**Live run log.**

| Date       | Scenario, seed               | Exit        | Detection                   | Bundle                                                                  | Traces (orders-api, worker)                      | Capture                                  | C3a                                                                                             | C3b                                                                | C5                                                                                                       |
| ---------- | ---------------------------- | ----------- | --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 2026-10-25 | `bad-deploy-order-reads`, 42 | 0 (success) | 15,007 ms after the trigger | `incidents/bad-deploy-order-reads-42-20261025T173140Z`, valid, complete | 1,500 and 406; 0 saturated slices, no truncation | traces 340 ms (34 requests), logs 222 ms | PASS: the symptom series, with no samples before the trigger, meets its condition 10 s after it | PASS: no scenario name, `/admin` or "fault" in the telemetry files | PASS: no active scenario, lock released, apps healthy, worker in-flight 0, API pool 0 used and 0 pending |

The run was made by the repository owner from a working tree with uncommitted changes (`producer.dirty: true`). It created 406 orders, every create in the plan, and used 1,097 units of stock.
