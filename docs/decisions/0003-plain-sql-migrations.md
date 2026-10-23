# 0003: Plain SQL migrations with a small in-repo runner

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

M1 needs forward-only, checked-in migrations that run locally, in CI, and as a one-shot Compose service. Later fault scenarios will depend on exact schema details such as which indexes exist, so the SQL must be explicit and reviewable.

## Decision

Migrations are plain SQL files named `NNN_description.sql` in `packages/db/migrations`. A runner of about 60 lines in `packages/db/src/migrate.ts` applies them in filename order.

- Each file runs in its own transaction together with its row in `schema_migrations`.
- A Postgres advisory lock serializes concurrent runners, for example two containers starting at once.
- There are no down migrations. Mistakes are fixed with a new forward migration.
- The same runner is used by `pnpm db:migrate`, the Compose `migrate` service, and the test global setup.

## Consequences

- **Positive:** No migration library dependency. The schema is exactly the SQL in the repo.
- **Positive:** Incident scenarios can reference specific migrations, such as one that drops or adds an index.
- **Negative:** No checksum verification of already-applied files. Editing an applied migration is not detected, so it is forbidden by convention.
- **Negative:** Statements that cannot run inside a transaction, such as `CREATE INDEX CONCURRENTLY`, are not supported yet.
- **Revisit if:** a migration needs non-transactional statements, or drift detection becomes necessary.
