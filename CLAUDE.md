# CLAUDE.md

Permanent engineering rules for the Commerce Platform repository.

## Purpose

A small, observable e-commerce backend whose real job is to produce realistic, reproducible operational incidents for the separate Engineering Operations AI Agent repository. Feature breadth is secondary to observability and deterministic fault reproduction.

## Hard constraints

- Runs fully locally with `docker compose`. No cloud services, paid APIs, or LLM calls anywhere in this repo.
- No runtime or build dependency on the agent repository. The only contract between the two repos is the incident bundle format in `docs/architecture.md`.
- Every fault scenario must be reproducible from a scenario name plus a seed.

## Stack

- TypeScript 6.0 (strict), Node.js 24 LTS, pnpm 12 workspaces. Stay on TypeScript 6.0 until typescript-eslint supports 7.
- Fastify for HTTP, Zod for config and input validation, PostgreSQL 16 for storage and order-processing coordination.
- ESLint, Prettier, and Vitest. Integration tests run against the Docker Compose Postgres locally and a Postgres service container in GitHub Actions.
- OpenTelemetry for traces, metrics, and logs, starting in M3.

## Code rules

- No `any` without a comment explaining why. Validate all external input and configuration with Zod at the boundary.
- Configuration comes from environment variables, validated at startup. Fail fast on invalid config.
- SQL lives in migrations and the data-access layer only. Migrations are plain SQL, forward-only, and checked in.
- Build apps through factory functions that receive their dependencies: config, pool, logger, and later clock and random source. No module-level singletons. This keeps telemetry and fault injection addable without rewrites.
- Add a workspace package only when it has real code in it. No empty placeholder packages.
- No generic job framework. Background work is modeled in domain terms. See ADR 0002.
- Logs are structured JSON. From M3, they include `trace_id` and every request and order-processing task carries trace context.
- Fault injection, once added in M5, lives in one dedicated package and is inert unless a scenario is explicitly enabled.
- Prefer small, boring dependencies. Justify any new dependency in the PR description.

## Workflow

- Before finishing a change, run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`. Do not claim success if any fail. Tests need the Compose Postgres running.
- New behavior needs tests. New fault scenarios need a test proving they trigger and a test proving they are off by default.
- Record significant decisions as ADRs in `docs/decisions/`. Update `docs/roadmap.md` and the README status when a milestone's status changes.
- Do not commit secrets, generated telemetry, or incident bundles. Use `.env.example` for configuration templates.
- Keep docs concise and consistent with each other. If code and docs disagree, fix one in the same change.
