# 0007: Incident bundle schema version 1

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

The incident bundle is the only contract between this repository and the separate Engineering Operations AI repository (CLAUDE.md, `docs/architecture.md`). That repository does not exist yet. It will read bundles to practice detection, diagnosis and remediation, and it must never depend on this repository's code, nor this one on it.

The architecture fixes the layout, `incidents/<scenario>-<seed>-<timestamp>/` with `manifest.json`, `traces.jsonl`, `metrics.jsonl`, `logs.jsonl` and `ground_truth.json`, and requires a versioned schema whose breaking changes need a new major version and an ADR. The M5 roadmap requires bundles to validate against that schema, and the same scenario and seed to give identical ground truth. The full design is `docs/prompts/m5-design.md`.

## Decision

- **Version 1.0.0.** Every bundle states `schemaVersion` in `manifest.json` and in `ground_truth.json`, as a semantic version string.
- **Source of truth and artifacts:**
  - The schema is defined once, as Zod schemas in `packages/incident-bundle`, using the repository's existing `zod` dependency.
  - Zod 4's `z.toJSONSchema` generates one JSON Schema (draft 2020-12) file per bundle document and per line format, committed under `docs/schemas/incident-bundle/v1/`.
  - A test fails if the committed files drift from the Zod schemas.
- **Validation:**
  - `pnpm incident validate <dir>` checks that every required file exists and that each file, and each line of each JSONL file, matches its schema.
  - It checks that `manifest.json`'s per-file SHA-256, byte count and record count match the files.
  - It checks that the major version is supported.
  - No new validator dependency is added.
- **Required files and content:**
  - `manifest.json` (volatile): `schemaVersion`; the bundle ID; the scenario name and seed; creation time; the run window and the actual trigger window; the source commit and whether the tree was dirty; service names, versions and instances; infrastructure image tags; the load profile, seed, plan hash and run prefix; the observed primary-symptom detection time; capture details, including trace truncation; and the per-file checksums and counts.
  - `ground_truth.json` (deterministic): `schemaVersion`; the scenario name, its integer `version` and the seed; a description; the root cause; the sorted affected components; the fault parameters; the primary symptom as a structured condition (metric, exact label matchers, evaluation, window, comparison, threshold and deadline); the secondary symptoms; the expected remediation; the expected data effects; and the timeline as offsets from the load start.
  - `traces.jsonl`: one trace per line as an OTLP JSON `TracesData` object.
  - `metrics.jsonl`: one series per line, with the metric name, labels and `[unixSeconds, value]` samples.
  - `logs.jsonl`: one normalized record per line, with service, ISO time, level, message, attributes, and `trace_id` and `span_id` when present.
- **Deterministic ground truth:**
  - `ground_truth.json` is a pure function of the scenario name, the scenario's `version`, the seed and the schema version. It is written as canonical JSON with sorted keys, and contains no timestamps, run IDs, order IDs or producer commit.
  - Two bundles made by the same producer commit for the same scenario and seed have byte-identical ground truth. A different commit gives the same ground truth unless the scenario's `version` or the schema version changed.
  - Everything volatile lives in `manifest.json` or the telemetry files, which are never compared byte for byte.
- **Open vocabularies:** scenario names and component identifiers are strings matching `^[a-z][a-z0-9-]*$`, not closed enumerations. Consumers must accept values they do not know, so adding a scenario or a component is not a breaking change. M5 uses the components `orders-api`, `worker`, `payment-provider` and `orders-api-pool`.
- **Compatibility policy:**
  - **Minor, 1.x:** adds optional fields, new files that are not required, new scenarios or component identifiers, or new optional attributes. Objects in the JSON Schema allow additional properties, so a consumer validating with an older 1.x schema still accepts a newer 1.x bundle. Consumers must ignore fields they do not know.
  - **Patch:** documentation or tightened descriptions only, never a change to what validates.
  - **Major:** removing or renaming a field, making an optional field required, changing a type, a file's format or a field's meaning, or changing which outputs are deterministic. A major version needs a new ADR, a new `docs/schemas/incident-bundle/v<N>/` directory, and a validator that names which majors it supports.
- **Independence from the Engineering Operations AI repository:**
  - The contract is the committed JSON Schema files plus this ADR.
  - That repository vendors a pinned copy of the files for the major version it supports, and validates with any JSON Schema validator.
  - Neither repository imports the other's code, packages or build output.
  - Bundles describe themselves through `schemaVersion`, so a consumer can refuse a major version it does not support.
- **Not in a bundle:** secrets, credentials and the Compose database's contents beyond what the telemetry shows. Bundles are written under `incidents/`, which is ignored by Git, and are never committed. M6's sample bundle is a deliberate, reviewed exception.

## Consequences

- **Positive:** one definition serves code and contract. Producers validate with Zod, and any consumer can validate with the JSON Schema files, in any language.
- **Positive:** ground truth is reproducible byte for byte, so the agent repository can compare its diagnoses against stable answers.
- **Positive:** open vocabularies and permissive objects let M5's scenario set grow without breaking consumers.
- **Negative:** permissive objects catch fewer mistakes than closed ones, such as a misspelled optional field. Required fields, types and formats are still enforced. The writer also builds each document from typed values, so it cannot emit fields the schema does not define.
- **Negative:** the generated JSON Schema follows Zod's output. Upgrading Zod can change it textually; the drift test makes such a change visible for review.
- **Revisit if:** the agent repository needs a format other than JSON Lines, a binary trace format such as OTLP protobuf, or bundles too large for single files.
