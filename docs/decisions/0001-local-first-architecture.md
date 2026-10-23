# 0001: Local-first architecture

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

This repository exists to generate operational incidents for a separate AI agent project. The incidents must be reproducible, cheap to run many times, and free of external variables. Reviewers of the portfolio should be able to run it without accounts or credentials.

## Decision

The whole system runs locally through Docker Compose.

- No cloud services, managed databases, or hosted observability.
- No paid APIs. External providers such as payments are simulated in process.
- No LLM calls in this repository.
- PostgreSQL is the system of record and also coordinates background order processing, which avoids adding a message broker. See ADR 0002.
- From M3, telemetry goes to a local OpenTelemetry Collector, Jaeger, and Prometheus.

## Consequences

- **Positive:** Runs are free, offline, and deterministic. Anyone can reproduce an incident from a scenario name and seed.
- **Positive:** Fewer moving parts make root causes easier to label accurately.
- **Negative:** Scale is limited to one machine, so some distributed failure modes cannot be shown.
- **Negative:** Simulated providers are less realistic than real ones. Their behavior must be documented in the scenario ground truth.
- **Revisit if:** a needed scenario cannot be reproduced locally, or order-processing throughput on Postgres becomes the bottleneck.
