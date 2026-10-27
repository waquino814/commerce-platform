# Incident scenarios, bundles and the handoff

What incidents this repository can produce, what a bundle contains, how to obtain or inspect one **without** running anything consequential, and how a bundle reaches [Engineering Operations AI](https://github.com/waquino814/engineering-operations-ai). Authoritative sources: [ADR 0007](decisions/0007-incident-bundle-schema-v1.md) (bundle schema v1), [docs/prompts/m5-design.md](prompts/m5-design.md), [docs/prompts/m5c-design.md](prompts/m5c-design.md), and the code under `packages/faults`, `packages/incident-bundle` and `apps/incident`.

## Scenarios that exist

Printed by `pnpm incident list` (read-only, no network). Every scenario is reproducible from its name plus a seed and is inert unless a run starts it.

| Scenario                 | Version | Primary symptom (from the captured bundles)                       | Root cause component |
| ------------------------ | ------: | ----------------------------------------------------------------- | -------------------- |
| `provider-outage`        |       1 | Reconciliation lookups against the payment provider fail          | `payment-provider`   |
| `payment-timeouts`       |       1 | Charge calls to the payment provider fail with an unknown outcome | `payment-provider`   |
| `api-pool-exhaustion`    |       1 | `POST /orders` returns HTTP 500 after waiting for a DB connection | `orders-api-pool`    |
| `bad-deploy-order-reads` |       1 | `GET /orders/:id` returns HTTP 500                                | `orders-api`         |
| `poison-order`           |       1 | Expired claims are recovered and returned to pending              | `worker`             |

The planned-but-unbuilt ideas in [architecture.md](architecture.md#fault-scenarios) (slow query from a missing index, stuck claims after a worker crash) are **not** scenarios today.

## Bundle format

One directory per run, `incidents/<scenario>-<seed>-<timestamp>/`, schema version `1.0.0`:

| File                | Content                                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`     | Scenario, seed and version; time window; trigger and detection; services and images; producer commit; load profile and plan hash; capture details (truncation flags, series lists); checksums, byte counts and record counts of the other files |
| `traces.jsonl`      | Traces captured from Jaeger (about 12 to 18 MB per run)                                                                                                                                                                                         |
| `metrics.jsonl`     | Metric samples captured from Prometheus at a 5 s step                                                                                                                                                                                           |
| `logs.jsonl`        | Structured JSON logs from the containers                                                                                                                                                                                                        |
| `ground_truth.json` | Root cause, affected components, expected remediation, primary and secondary symptoms, timeline, data effects. **The answer key**; an investigator must never see it                                                                            |

`incidents/` is git-ignored: bundles are not committed (project rule, ADR 0007). A validated bundle is checked by `pnpm incident validate <dir>`, which makes no network call.

### Variants that exist

The schema allows more than the runs so far show. The bundles actually observed on disk (eight, all seed 42, 2026-10-25 and 2026-10-26, produced from clean commits) differ in these ways:

- **Scenario:** all five above; `provider-outage` twice, `poison-order` twice, `api-pool-exhaustion` twice.
- **Detection:** seven runs detected the primary symptom within the 120 s deadline (10 to 65 s); one `poison-order` run was **not detected** (`detection.detectedAt: null`), a legitimate bundle that the dashboard shows as "not detected" ([screenshot](images/dashboard-07-incident-poison-order-not-detected.png)).
- **Capture:** every bundle's trace capture reports `truncated: false` for both services.
- **Validity:** every bundle validates; the dashboard shows "valid · complete".

Varied fault timing does not exist: every real bundle faults 30 s after load start. Other seeds were not run.

> The roadmap's M5 run log ([m5c-design.md](prompts/m5c-design.md), section 14) and the bundles on disk may not be in step: two `provider-outage` bundles dated 2026-10-26 exist, while the roadmap text still lists `provider-outage` among the scenarios whose criteria remain. This documentation does not change milestone status; the owner should reconcile the roadmap with the runs.

## Obtaining a bundle safely

| Goal                                      | Command                                                   | Effect                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| List scenarios                            | `pnpm incident list`                                      | Read-only, no network.                                                                                 |
| Show a scenario's ground truth for a seed | `pnpm incident ground-truth --scenario <name> --seed <n>` | Read-only, no network.                                                                                 |
| Validate an existing bundle               | `pnpm incident validate <bundle-dir>`                     | Read-only, no network. Exit 0 valid, 1 otherwise.                                                      |
| Check the stack is ready to capture       | `pnpm incident capture-check`                             | Read-only: never starts faults, services or load, writes nothing. Exit 0 pass, 1 fail, 5 inconclusive. |
| Browse existing bundles                   | `pnpm web`, open `http://127.0.0.1:3100`                  | Read-only dashboard over `INCIDENTS_DIR`.                                                              |
| **Produce a new bundle**                  | `pnpm incident run --scenario <name> --seed <n>`          | **Consequential.** See below.                                                                          |

All commands except `run` need `pnpm build` first.

### Why `run` needs care

`pnpm incident run` runs a scenario end to end against the local Compose stack: it checks local isolation, starts seeded load, starts a fault through the scenario control endpoints (which exist only when `FAULTS_ENABLED=true`, via `compose.faults.yaml`), waits for the symptom, captures telemetry, stops the fault and writes the bundle. It creates real orders, may hold stock for up to 15 minutes (`provider-outage`), and runs for minutes. Repository rule ([CLAUDE.md](../CLAUDE.md)): every live run needs the owner's separate approval, and starting the stack with `compose.faults.yaml` does too. The documentation work that produced this page ran no scenario and started no fault.

If you are the owner and want a fresh bundle, follow [m5c-design.md](prompts/m5c-design.md) rather than improvising: start the stack with both Compose files, run `pnpm incident capture-check`, then `pnpm incident run --scenario <name> --seed <n>`.

## Handoff to Engineering Operations AI

- **Contract:** the incident bundle, schema v1, and nothing else. Neither repository imports, links or builds the other. Engineering Operations AI keeps a pinned copy of the schemas and validates with its own code ([ADR 0007](decisions/0007-incident-bundle-schema-v1.md)).
- **Mechanism:** copy a bundle **directory** by hand into that project's bundles directory (default `~/.engineering-operations-ai/bundles/`, overridable with `EOAI_BUNDLES_DIR`), validate it there, and investigate it from its console. There is no runtime connection, shared database or API call between the projects.
- **Ground truth** travels inside the bundle. Engineering Operations AI hides it from the investigation and reads it only to validate the bundle and to score evaluations ([its ADR 0003](https://github.com/waquino814/engineering-operations-ai/blob/main/docs/adr/0003-ground-truth-isolation.md)).

**Verified 2026-10-27.** A copy of the existing bundle `provider-outage-42-20261026T123450Z` passed `pnpm incident validate` here and `pnpm validate-bundle` in Engineering Operations AI (schema 1.0.0), and was investigated from that project's console with its **simulated Fake provider**: the run completed and its three citations were re-checked against the bundle. The output was a placeholder, not a diagnosis; no real model has investigated a real bundle. The verification used a scratch data directory in the other project; no scenario was run. The procedure is written up on its side: [docs/commerce-platform-handoff.md](https://github.com/waquino814/engineering-operations-ai/blob/main/docs/commerce-platform-handoff.md).
