# Commerce Platform

A small, observable, local-first e-commerce backend built to generate realistic, reproducible operational incidents.

It is the first of two repositories in an AI engineering portfolio. The second, the **Engineering Operations AI Agent**, consumes the telemetry and incident bundles produced here to practice detection, diagnosis, and remediation. This repository contains no AI code.

## Planned components
- **Orders API** (`apps/orders-api`): TypeScript and Fastify service for catalog and order endpoints.
- **Order worker** (`apps/worker`): background processing of placed orders, covering inventory reservation and simulated payment.
- **PostgreSQL:** system of record. Order status rows also coordinate the worker, so no message broker is needed.
- **Observability:** OpenTelemetry traces, metrics, and logs, collected locally. Arrives in M3.
- **Load generator:** deterministic traffic so incidents happen under realistic load. Arrives in M4.
- **Fault scenarios:** opt-in, seeded fault injection that produces named incidents with ground-truth labels. Arrives in M5.

## Status
**M0, Foundation:** complete apart from the first commit. Documentation, engineering rules, and ADRs exist.
**M1, Skeleton:** next. It delivers the workspace, the orders schema, the two services with health endpoints, Docker Compose, and CI.
No application code exists yet. See [docs/roadmap.md](docs/roadmap.md) for milestone boundaries.

## Requirements
- Node.js 24 LTS and pnpm
- Docker with Docker Compose v2

No cloud accounts, API keys, or LLMs are required.

## Documentation
- [Architecture](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Decision records](docs/decisions/)
- [Engineering rules](CLAUDE.md)
