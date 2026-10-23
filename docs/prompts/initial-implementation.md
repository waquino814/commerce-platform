# Initial implementation prompt

Status: approved and implemented. Scope is milestone M1 from `docs/roadmap.md`. Deviations are recorded in the M1 completion report and in `docs/roadmap.md`.

---

Implement milestone M1 (Skeleton, schema, and health) for the Commerce Platform repository.

Read `CLAUDE.md`, `docs/architecture.md`, `docs/roadmap.md`, and every ADR in `docs/decisions/` first, and follow them. If anything below conflicts with those documents, stop and report the conflict.

## Deliver

1. **Workspace.** A pnpm workspace with exactly `apps/orders-api`, `apps/worker`, and `packages/db`. Pin Node 24 with `.nvmrc` and `engines`, and pin pnpm with `packageManager`. Use a root `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`, and build with TypeScript project references. Do not create any other package or directory placeholder.
2. **Tooling.** ESLint flat config with `typescript-eslint`, Prettier, and Vitest. Root scripts: `build`, `dev`, `lint`, `format`, `format:check`, `typecheck`, `test`, and `db:migrate`.
3. **`packages/db`.**
   - Plain SQL migrations applied in order by a small runner that records them in a `schema_migrations` table inside one transaction per file.
   - Migration `001_orders.sql` creates the `orders` table: `id uuid` primary key defaulting to `gen_random_uuid()`, `status` constrained to `pending`, `processing`, `paid`, `failed`, `total_cents integer` checked non-negative, `currency char(3)`, `processing_attempts integer` default 0, `claimed_by text`, `claimed_at timestamptz`, `last_error text`, `created_at`, and `updated_at`. Add a partial index on `created_at` where `status = 'pending'`.
   - A `createPool(config)` factory and a `claimPendingOrders(pool, { workerId, limit })` function that uses one `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` statement and returns the claimed rows.
4. **`apps/orders-api`.**
   - Zod-validated config: `DATABASE_URL`, `PORT` default 3000, `LOG_LEVEL` default `info`.
   - `buildServer({ config, pool, logger })` factory, separate from `src/main.ts`, which is the only entrypoint.
   - `GET /healthz` returns 200 `{"status":"ok"}` whenever the process is running and never touches the database.
   - `GET /readyz` runs `SELECT 1` with a 1 second timeout. It returns 200 `{"status":"ready"}` on success, and 503 `{"status":"not_ready"}` with the failure logged otherwise.
   - On SIGTERM or SIGINT, stop accepting requests, close the server and pool, and exit with code 0.
5. **`apps/worker`.**
   - The background worker for order processing. In M1 it only claims `pending` orders, moving them to `processing`. It does not reserve inventory, simulate payment, or recover stale claims. Those arrive in M2.
   - Zod-validated config: `DATABASE_URL`, `WORKER_ID` defaulting to the hostname, `POLL_INTERVAL_MS` default 1000, `CLAIM_BATCH_SIZE` default 10, `HEALTH_PORT` default 3001.
   - A poll loop that calls `claimPendingOrders` and logs each claim. On SIGTERM it finishes the current iteration, closes the pool, and exits with code 0.
   - A Fastify health server on `HEALTH_PORT` with the same `/healthz` and `/readyz` semantics as the orders API.
6. **Docker Compose.** `compose.yaml` with `postgres:16`, a one-shot `migrate` service, `orders-api`, and `worker`. The apps start only after `migrate` completes successfully. Every long-running service has a health check. Postgres runs an init script that also creates a `commerce_test` database for tests. Use one multi-stage Dockerfile with a non-root runtime user. Add `.env.example` with every variable documented.
7. **GitHub Actions.** One workflow on push and pull request. It runs install with a frozen lockfile, format check, lint, typecheck, migrations, and tests against a `postgres:16` service container.
8. **Tests.**
   - Config validation rejects missing or invalid values in both apps.
   - `/healthz` and `/readyz` behave correctly with a reachable and an unreachable database, using Fastify `inject`.
   - Two concurrent `claimPendingOrders` calls over 100 pending orders claim each order exactly once.
   - The migration runner is idempotent.
   - Integration tests use `TEST_DATABASE_URL` pointing at `commerce_test`, and reset tables between tests.

## Out of scope for M1

Commerce endpoints, products, inventory, payment simulation, stale claim recovery, OpenTelemetry export, load generation, fault injection, and any generic job framework. Do not add dependencies for these.

## Keep future milestones easy

- Keep construction in factories, with `src/main.ts` as the only entrypoint per app, so M3 can preload OpenTelemetry with `node --import`.
- Use pino through Fastify in both apps, so M3 only needs to add `trace_id`.
- Pass the pool and other dependencies in as parameters, never as module singletons, so M5 can wrap them for fault injection.

## Acceptance verification

Run these from a clean clone of the repository and report each result. Copy `.env.example` to `.env` first.

```sh
# 1. Install, format, lint, typecheck, build
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build

# 2. Migrations apply and are idempotent; tests pass
docker compose up -d --wait postgres
pnpm db:migrate        # applies 001_orders.sql
pnpm db:migrate        # reports 0 migrations applied
pnpm test

# 3. Full stack becomes healthy within 120 seconds
docker compose up -d --build --wait --wait-timeout 120
docker compose ps      # orders-api, worker, postgres healthy; migrate exited 0

# 4. Health and readiness
curl -fsS localhost:3000/healthz    # {"status":"ok"}
curl -fsS localhost:3000/readyz     # {"status":"ready"}
curl -fsS localhost:3001/readyz     # {"status":"ready"}

# 5. Readiness reflects database loss and recovery
docker compose stop postgres
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/readyz   # 503
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/healthz  # 200
docker compose start postgres && sleep 10
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/readyz   # 200

# 6. Worker claims a pending order
docker compose exec -T postgres psql -U commerce -d commerce -c \
  "INSERT INTO orders (total_cents, currency, status) VALUES (1000, 'USD', 'pending');"
sleep 3
docker compose exec -T postgres psql -U commerce -d commerce -tAc \
  "SELECT status, processing_attempts, claimed_by IS NOT NULL FROM orders;"   # processing|1|t

# 7. Graceful shutdown within 10 seconds with exit code 0
time docker compose stop -t 10 orders-api worker
docker inspect -f '{{.State.ExitCode}}' $(docker compose ps -aq orders-api worker)   # 0 and 0

# 8. Invalid configuration fails fast
DATABASE_URL=not-a-url node apps/orders-api/dist/main.js; echo "exit=$?"   # non-zero, names DATABASE_URL

docker compose down -v
```

9. **CI:** after the first push, the GitHub Actions workflow shows a green run.

## Finish

- Report each acceptance check as pass or fail with its output. Do not mark M1 done if any check fails.
- Update the M1 status in `docs/roadmap.md` and the README.
- Record any decision not already covered by an ADR, such as the migration runner design, as a new ADR.
