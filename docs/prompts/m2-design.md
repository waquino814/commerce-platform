# M2 design: working commerce flow

Status: approved, implemented, and done. All 36 acceptance criteria pass, and GitHub Actions is green for commit `3950841`.

Implementation notes. None of these change the design:

- **Migration order:** migration 002 adds the new order columns before failing M1 rows. Those rows need the columns, and this still happens before the constraints and the trigger.
- **Release lock order:** the stock release inside "finalize to `failed`" locks product rows in SKU order within its single statement, matching the reservation's lock order to avoid deadlocks. The statement count is unchanged.
- **Claim order:** claimed rows are returned oldest-due first, because `RETURNING` does not keep the subquery's order.

## Scope

In: product listing, order creation and retrieval, deterministic seed data, inventory reservation, a local payment simulator, retries, stale claim recovery, payment reconciliation, graceful shutdown, and an enforced order lifecycle.
Out: carts, cancellation, refunds, fulfilment, authentication, OpenTelemetry, load generation, and fault injection.

## Order lifecycle

```
                       claim when due
pending ─────────────────────────────────▶ processing ── approved ───────────────────────▶ paid             (terminal)
   ▲                                        │  │  │
   │ charge error with charge budget left,  │  │  └─ out_of_stock | payment_declined |
   │ lookup error below the limit,          │  │     max_attempts_exceeded ─────────────▶ failed           (terminal)
   │ recovery or release (not parked)       │  │
   └────────────────────────────────────────┘  └── lookup error at the limit, or ──────▶ payment_unknown
                                                    recovery or release of a parked order       │
                                        processing ◀── claim when due (reconciliation only) ────┘
```

| From              | To                | When                                                                                                                                                                      |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`         | `processing`      | A worker with a free slot claims the order, with `next_attempt_at <= now()`.                                                                                              |
| `payment_unknown` | `processing`      | Same claim, once `next_attempt_at <= now()`. The pass is always a reconciliation pass.                                                                                    |
| `processing`      | `paid`            | An authoritative approval: from `charge`, new or replayed, or from `lookupOrVoid`.                                                                                        |
| `processing`      | `failed`          | `out_of_stock`, `payment_declined`, or `max_attempts_exceeded`. The last one is only set after the provider records a void.                                               |
| `processing`      | `pending`         | A charge error with charge budget left. A lookup error with `reconciliation_attempts` still below the limit. Recovery or shutdown release of an order that is not parked. |
| `processing`      | `payment_unknown` | A lookup error that brings `reconciliation_attempts` to the limit or beyond. Recovery or shutdown release of an order already at the limit, which is called parked.       |

- The trigger rejects every other transition. A same-status update, such as changing `next_attempt_at`, is allowed.
- `paid` and `failed` are terminal. M2 has no cancel or refund.
- Every transition out of `processing` clears `claimed_by` and `claimed_at`. A table constraint enforces it.
- `failure_reason` is one of `out_of_stock`, `payment_declined`, or `max_attempts_exceeded`, plus `invalid_order` for M1 rows. `last_error` keeps the most recent transient error text.
- Claim recovery and shutdown release never set `failed`, never release inventory, and never call the provider.

**Why an order may stay in `processing`:** only while a worker is actively processing it. A claim lasts at most `CLAIM_TIMEOUT_MS`, default 60 s. After that, recovery returns the order to `pending`, or to `payment_unknown` if it is parked.

## Attempt counters

Three counters on `orders` replace the single attempt count of earlier revisions. None ever decreases, and recovery and release never change them.

| Column                    | Incremented by                                                                                                                                       | Meaning                                            | Limits and uses                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `processing_attempts`     | The claim statement, in the same row update that sets `status = 'processing'`, `claimed_at = now()` and `claimed_by`.                                | Number of claims.                                  | It is the fencing token. `MAX_CLAIMS`, default 10, bounds passes that never charge.    |
| `charge_attempts`         | A fenced update committed immediately before a `charge` call. When the reservation runs in the same pass, this is the reservation's final statement. | `charge` calls that may have reached the provider. | `MAX_CHARGE_ATTEMPTS`, default 3, is the payment retry budget. Charge backoff uses it. |
| `reconciliation_attempts` | The fenced finalize after a `lookupOrVoid` error.                                                                                                    | Lookup errors.                                     | `MAX_RECONCILIATION_ATTEMPTS`, default 5, decides when the order is parked.            |

- **Shutdowns and crashes don't spend the payment budget.** A pass released before its charge increment committed spends a claim but no charge attempt.
  - A pass aborted after the increment but before the request was sent does spend one. That is the conservative choice, because the system cannot know whether the request left.
  - `MAX_CLAIMS` bounds orders that keep getting claimed without charging, through crash loops or repeated shutdowns.
- **Pass selection** is a pure function of the claimed row. A pass is a **reconciliation pass** if `reconciliation_attempts > 0`, or `charge_attempts >= MAX_CHARGE_ATTEMPTS`, or `processing_attempts > MAX_CLAIMS`. Otherwise it is a **charge pass**.
  - All three conditions only ever stay true once true. After an order's first reconciliation, it never gets another `charge` call.
  - A `payment_unknown` order always has `reconciliation_attempts >= 1`, so its passes always reconcile.

## Worker capacity and claiming

**Invariant:** a worker never holds a claim on an order it is not actively processing. Every claimed order starts processing in the same event-loop turn in which the claim query returns, so no claimed order waits in memory.

- `WORKER_CONCURRENCY` is new, with a default of 5. It is the maximum number of orders one worker process handles at once. The M1 setting `CLAIM_BATCH_SIZE` stays, as an upper bound for a single claim query.
- Only the worker loop claims. Before each claim it computes `free = WORKER_CONCURRENCY - inFlight`.
  - If `free` is 0, no claim query is sent.
  - Otherwise the claim limit is `min(free, CLAIM_BATCH_SIZE)`.
- **The claim query:** a single `UPDATE`. Its subquery selects `status IN ('pending', 'payment_unknown') AND next_attempt_at <= now()`, ordered by `next_attempt_at, created_at`, with `FOR UPDATE SKIP LOCKED`. The update increments `processing_attempts`.
- When the claim returns, the loop starts processing each row and increments `inFlight` synchronously, before any `await`. A finished order frees its slot and wakes the loop at once.
- **Connection pools:**
  - The worker's pool size is `WORKER_CONCURRENCY + 2`: one connection per slot, one for claiming, recovery and the shutdown release, and one for readiness.
  - The payment simulator stands in for an external provider, so it has its own pool of `2 × WORKER_CONCURRENCY`.
- **Waiting orders hold no claim.** An order without a free slot is never claimed, so it has no claim that could expire. The claim clock starts only when processing starts.
- **Several workers:** each enforces its own cap. `SKIP LOCKED` keeps their claims disjoint.
- **Lease renewal is not needed.** Processing is bounded well below the claim timeout, as calculated next. A process stalled beyond the bound is made safe by fencing and the provider protocol.

## Worst-case processing time

| Symbol | Setting                   | Default | Bounds                                                                                                                               |
| ------ | ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| C      | `DB_CONNECT_TIMEOUT_MS`   | 2000    | Acquiring a pool connection.                                                                                                         |
| S      | `DB_STATEMENT_TIMEOUT_MS` | 2000    | Each SQL statement, including `BEGIN`, `COMMIT` and lock waits, through `statement_timeout`.                                         |
| P      | `PAYMENT_TIMEOUT_MS`      | 5000    | Each provider call, enforced by the worker. It includes waiting for the per-order ledger lock and the simulator's own database work. |

The bound is measured from the moment `claimed_at` is written:

| Path                                       | Segments                                                                                                                                                                                                                                                                       | Bound         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Charge pass with reservation, last attempt | Rest of the claim statement: S. Reservation: C + 6S, for `BEGIN`, lock order, lock products, decrement, marker and charge increment, `COMMIT`. `charge`: P. `lookupOrVoid` after a charge error: P. Finalize: C + 4S, for `BEGIN`, fenced update, release inventory, `COMMIT`. | 2C + 11S + 2P |
| Charge pass, reservation already made      | S, plus C + S for the fenced charge increment, plus P + P, plus C + 4S.                                                                                                                                                                                                        | 2C + 6S + 2P  |
| Out of stock                               | S + (C + 5S), for `BEGIN`, lock order, lock products, decrement, `ROLLBACK`. Then S for the fenced failure on the same connection.                                                                                                                                             | C + 7S        |
| Reconciliation pass                        | S + P + (C + 4S)                                                                                                                                                                                                                                                               | C + 5S + P    |

```
budget = 2C + 11S + 2P = 2(2 s) + 11(2 s) + 2(5 s) = 4 + 22 + 10 = 36 s
```

- This revision adds a fenced charge increment. On the reservation path it merges into the marker statement, so the count does not change. On the other path it adds C + S, which is still below the maximum. The bound stays 36 s.
- Startup validation requires `CLAIM_TIMEOUT_MS >= 1.5 × budget`. With defaults that is 54 s, against the 60 s default.
- **Not covered:**
  - event-loop stalls, which fencing covers;
  - a `COMMIT` waiting on a write-ahead log flush, which may not be interruptible. Locally that takes milliseconds;
  - provider work that continues after the worker's timeout, which the ledger protocol handles.

## Processing protocol

### State-changing writes and their guards

| Write             | Guard                                                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim             | One statement under `FOR UPDATE SKIP LOCKED` that requires a claimable status and a due time. It issues the new token.                                                                                                                                                             |
| Reservation       | It first locks the order with `status = 'processing' AND processing_attempts = <token> AND inventory_reserved_at IS NULL`. Product updates, the marker and the charge increment happen only in that transaction, and only after the lock matched.                                  |
| Charge increment  | When no reservation runs: `UPDATE ... SET charge_attempts = charge_attempts + 1 WHERE id = $1 AND status = 'processing' AND processing_attempts = <token> AND charge_attempts < MAX_CHARGE_ATTEMPTS RETURNING charge_attempts`. Without a returned row, no `charge` call is made.  |
| Finalize          | A fenced `UPDATE ... WHERE id = $1 AND status = 'processing' AND processing_attempts = <token> RETURNING ...`. It also clears the claim columns.                                                                                                                                   |
| Inventory release | Only in the same transaction as a fenced transition to `failed`, only when that update returned the row, and only if `inventory_reserved_at IS NOT NULL AND inventory_released_at IS NULL`. It sets `inventory_released_at`.                                                       |
| Shutdown release  | Fenced by `(id, token)` and `status = 'processing'`, under `SKIP LOCKED`. See "Shutdown protocol".                                                                                                                                                                                 |
| Claim recovery    | It holds no token. One statement re-checks `status = 'processing' AND claimed_at < now() - CLAIM_TIMEOUT_MS` under `FOR UPDATE SKIP LOCKED`. Its target status follows the same rule as release. Its due time is the recovery backoff, or the recheck interval for a parked order. |
| Provider ledger   | Not fenced, because it is the external provider's state. It is serialized per order by the provider's own lock. See "Payment simulator".                                                                                                                                           |

Every state-changing write a worker makes to an order requires `status = 'processing'` and its own token. A worker whose claim was recovered, released, or taken over changes nothing, and logs `claim_lost`.

### Steps

1. **Claim,** limited to free slots.
2. **Choose the pass type** by the rule in "Attempt counters".
3. **Charge pass:**
   - **Reservation,** when `inventory_reserved_at` is null. One six-statement transaction:
     - lock the order, fenced;
     - lock the product rows in SKU order;
     - decrement all items in one `UPDATE` where `stock_available >= quantity`;
     - set the marker and increment `charge_attempts` in one statement.

     If any item is short, the transaction rolls back and a fenced update sets `failed` with `out_of_stock`. The marker, the decrements and the first charge increment commit together.

   - **Already reserved:** run the fenced charge increment instead.
   - **`charge`:** called outside any transaction. The result is `approved`, `declined` or `voided`, all authoritative, or an **error**. An error means the outcome is unknown, never "no charge".
   - **Finalize,** fenced:
     - **approved:** `paid`, with `paid_at` and the ledger reference.
     - **declined:** `failed` with `payment_declined`, and inventory is released.
     - **voided:** `failed` with `max_attempts_exceeded`, and inventory is released.
     - **error with `charge_attempts < MAX_CHARGE_ATTEMPTS`:** `pending`, with `next_attempt_at = now() + chargeBackoff(charge_attempts)`. The reservation is kept.
     - **error with `charge_attempts = MAX_CHARGE_ATTEMPTS`:** reconcile in the same pass.
     - **unexpected exception:** treated as an error.
     - **no row returned:** log `claim_lost` and stop.
4. **Reconciliation pass:** skip reservation and the charge increment, and never call `charge`. Run "Reconciliation".
5. **Claim recovery** runs on every poll, even with no free slot, and stops on SIGTERM.

**Backoff:**

| Use            | Formula                                                                                                          | Defaults      |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ------------- |
| Charge         | `min(RETRY_BASE_DELAY_MS × 2^(charge_attempts−1), RETRY_MAX_DELAY_MS)`                                           | 1 s, max 30 s |
| Recovery       | `min(RETRY_BASE_DELAY_MS × 2^(processing_attempts−1), RETRY_MAX_DELAY_MS)`                                       | 1 s, max 30 s |
| Reconciliation | `min(RECONCILIATION_BASE_DELAY_MS × 2^(k−1), RECONCILIATION_MAX_DELAY_MS)`, where k is `reconciliation_attempts` | 5 s, max 60 s |

There is no jitter.

### Reconciliation

`lookupOrVoid(orderId)` returns the recorded outcome, or atomically records `voided` when there is none. Once a void is recorded, no charge for that order can ever be created.

| Result                                          | Meaning                                                   | Action, all fenced                                                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approved`                                      | Authoritative: the charge exists.                         | `paid`, with the recorded reference. Inventory is not reserved again, because reconciliation passes never reserve.                                                         |
| `declined`                                      | Authoritative: a decline was recorded.                    | `failed` with `payment_declined`, and inventory is released.                                                                                                               |
| `voided`                                        | Authoritative: no charge exists, and none can be created. | `failed` with `max_attempts_exceeded`, and inventory is released. See below for why the order does not try again.                                                          |
| error, such as a timeout, cancellation or fault | Unknown.                                                  | Increment `reconciliation_attempts`, then go to `pending` or `payment_unknown` as described in the next section. There is no charge, no failure, and no inventory release. |

**Why a void ends the order.** After a void, the provider refuses any charge for that order id, so the order cannot be paid anymore. Failing it and releasing its stock is the safe next step, because no money was or can be taken. A customer who still wants the goods places a new order. Automatically re-charging under a new provider key would be a new purchase, which M2 does not do.

**An approval always has its stock reserved.** A `charge` call happens only after `charge_attempts` was incremented, and the database requires `charge_attempts = 0 OR inventory_reserved_at IS NOT NULL`. So any recorded approval belongs to an order whose stock is already reserved, and `paid` never needs another reservation.

## `payment_unknown`

`payment_unknown` means the provider could not tell us whether a charge exists. It is a parked, non-terminal state that keeps the order recoverable.

| Aspect              | Rule                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entered from        | Only from `processing`: a lookup error with `reconciliation_attempts` now at or beyond `MAX_RECONCILIATION_ATTEMPTS`, or recovery or release of a pass on an order already at that limit.                                                                                                                           |
| Left to             | Only `processing`, through a normal claim once due. The trigger rejects moves straight to `pending`, `paid` or `failed`.                                                                                                                                                                                            |
| Constraints         | `status <> 'payment_unknown' OR reconciliation_attempts >= 1`. Claim columns must be null outside `processing`. `inventory_released_at` may be set only when the status is `failed`.                                                                                                                                |
| Due time            | On entry, `next_attempt_at = now() + PAYMENT_UNKNOWN_RECHECK_MS`, default 15 min and at least 60 s.                                                                                                                                                                                                                 |
| Index               | The claim index `(next_attempt_at, created_at) WHERE status IN ('pending', 'payment_unknown')` serves both statuses.                                                                                                                                                                                                |
| What a recheck does | A reconciliation pass: one `lookupOrVoid` call, never `charge`, never a reservation. `approved` gives `paid`, `declined` gives `failed` with release, and `voided` gives `failed` with release. An error increments `reconciliation_attempts` and returns the order to `payment_unknown` with the next recheck due. |
| Interrupted recheck | Recovery or shutdown release returns a parked order to `payment_unknown`, with the next recheck one interval away, never to `pending`. An interruption therefore cannot cause a burst of lookups.                                                                                                                   |
| Inventory           | Stays reserved. It can only be released by a fenced transition to `failed` after an authoritative `declined` or `voided`.                                                                                                                                                                                           |
| Manual retry        | `UPDATE orders SET next_attempt_at = now() WHERE id = $1 AND status = 'payment_unknown'`. This is a same-status update, which the trigger allows.                                                                                                                                                                   |
| API                 | `status: "payment_unknown"`, together with `lastError`, `reconciliationAttempts`, and `nextAttemptAt`, the next recheck time. A future UI can show "payment being verified".                                                                                                                                        |
| Several workers     | Only one claim can succeed per due time, because of the status predicate and `SKIP LOCKED`. Stale passes are fenced out. Rechecks never call `charge`, and the provider's per-order lock makes concurrent lookups consistent. There is therefore no duplicate charge and no conflicting transition.                 |
| Hot loops           | Every automatic path back to a claimable status sets a future due time. Startup validation enforces the minimum delays: retry 100 ms, reconciliation 1 s, recheck 60 s. The only immediate requeue is the shutdown release of an unparked order, once per shutdown.                                                 |

## Shutdown protocol

The M1 hard deadline of 8 s and the Compose grace period of 10 s stay. Shutdown never decides an order's outcome. It stops waiting, hands claims back, and leaves every decision to a later pass.

| Time           | Action                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0, SIGTERM    | Stop claiming and stop claim recovery. Rows from a claim query already in flight are still dispatched.                                                                                                                                                    |
| T0 to T0 + 7 s | Drain. In-flight passes run normally. No new pass starts.                                                                                                                                                                                                 |
| T0 + 7 s       | Abort the remaining passes. A pass checks the abort signal before every step and sends nothing further. Aborting writes nothing.                                                                                                                          |
|                | Destroy the aborted passes' connections. Postgres rolls back any transaction they left open. A `COMMIT` already sent either commits fully or not at all. A statement still running server-side may keep its row lock until its own 2 s statement timeout. |
|                | Release, described below, on the spare connection, with `statement_timeout = 500ms`.                                                                                                                                                                      |
| By T0 + 8 s    | Close the pools and exit with the code given below. The M1 hard timer still forces exit code 1 at 8 s.                                                                                                                                                    |

**The release statement:**

```sql
UPDATE orders o
   SET status          = CASE WHEN o.reconciliation_attempts >= $max_recon THEN 'payment_unknown' ELSE 'pending' END,
       next_attempt_at = CASE WHEN o.reconciliation_attempts >= $max_recon THEN now() + $recheck ELSE now() END,
       claimed_by      = NULL,
       claimed_at      = NULL,
       last_error      = 'released_on_shutdown',
       updated_at      = now()
 WHERE o.id IN (SELECT id FROM orders
                 WHERE (id, processing_attempts) IN (<unfinished id and token pairs>)
                   AND status = 'processing'
                   FOR UPDATE SKIP LOCKED)
RETURNING o.id;
```

- It changes no counter and no inventory, and makes no provider call.
- `SKIP LOCKED` means a row whose lock is still held, for example by an aborted statement still running server-side, is skipped instead of waited on. The release can never block the exit.
- A follow-up read, without locks, of the unfinished ids that were not returned classifies them:
  - **no longer `processing` with our token:** something else already finished or recovered the order. Nothing to do.
  - **still `processing` with our token:** **unconfirmed**. The lock was held.
- A statement error, such as the database being down or the 500 ms timeout, makes every unfinished order unconfirmed.

**Exit code:** 0 when every in-flight order finished, or was released or confirmed as no longer held. 1 when any order is unconfirmed, or the hard timer fired.

**Why an unconfirmed release is safe:**

- The order stays `processing` with the old token. The aborted pass sends nothing more, and its connections are gone.
- Whatever transaction held the lock either commits atomically or rolls back. If it was a finalize that commits, the order reaches a correct terminal state. If it rolls back, the order is unchanged.
- Once `CLAIM_TIMEOUT_MS` has passed since `claimed_at`, recovery returns the order to `pending` or `payment_unknown`. The next claim issues a higher token, so any write carrying the old token can never match again.
- Inventory and the provider ledger are untouched by both shutdown and recovery. A charge recorded just before exit is found by the next `charge`, which replays it, or by `lookupOrVoid`.

**What each unfinished state becomes after a successful release:**

- **Before the reservation committed:** that transaction rolled back. The order becomes `pending`, with nothing reserved and no charge attempt spent.
- **Reservation committed, charge not sent:** `pending`, with the reservation kept and one charge attempt spent.
- **Charge in flight:** `pending`. The abandoned request is unknown and never interpreted. The provider's per-order lock means it either recorded before any later operation, which then sees it, or it waits behind a later operation and then sees that one's outcome.
- **Finalize in flight:** it committed, so the fenced release matches nothing. Or it rolled back, and the order becomes `pending`.
- **Recheck of a parked order:** `payment_unknown`, with the next recheck one interval away.

## Payment simulator

- It runs in process and is injected into the worker as an interface with `charge` and `lookupOrVoid`, so tests can replace it and M5 can wrap it for faults.
- The client passes a test payment method, like a card processor's test tokens:
  - `pm_card_ok` is approved.
  - `pm_card_declined` is declined.
  - `pm_card_unavailable` makes `charge` return a "provider unavailable" error without recording anything.
- `PAYMENT_LATENCY_MS`, default 50 ms, simulates the provider's processing time.
- **Ledger:** `payment_charges`, with `order_id` as the primary key. Only the simulator module reads or writes it. It uses its own connection pool, with `statement_timeout` set to `PAYMENT_TIMEOUT_MS`, so even its lock waits are bounded on the server.

### Per-order serialization protocol

Every `charge` and `lookupOrVoid` call is one transaction that holds a per-order lock from the first read until `COMMIT`:

```sql
BEGIN;
SELECT pg_advisory_xact_lock(<simulator namespace>, hashtext($order_id::text));
SELECT outcome, reference, amount_cents FROM payment_charges WHERE order_id = $order_id;
-- A row exists:              COMMIT. Return it with replayed = true.
-- charge, no row:            wait PAYMENT_LATENCY_MS, then decide from the payment method.
--     approved or declined:  INSERT the row. COMMIT. Return it with replayed = false.
--     unavailable:           COMMIT with no insert. Return a provider error.
-- lookupOrVoid, no row:      INSERT outcome 'voided'. COMMIT. Return voided.
```

- **One decision per order at a time.** For a given order, read, decide, and record form one critical section. A second call for the same order waits in Postgres's lock queue until the first commits or rolls back, then reads what the first recorded.
- **Charge wins the race:** `lookupOrVoid` waits, then finds the approved or declined row and returns it. It never records a void over an existing charge, and every later lookup returns the same row.
- **Void wins the race:** `charge` waits, then finds `voided` and returns `voided`. It never inserts, so no charge can be created for that order afterwards. Every later `charge` returns `voided` as well.
- **Abandoned requests:** if the worker stops waiting, the simulator's transaction still finishes on its own. It either commits its decision atomically or rolls back with nothing recorded. A late commit can only happen while it holds the lock, so any operation that runs afterwards sees it.
- **What the unique key adds.** The lock is the mechanism, and the primary key is a backstop.
  - Inserts are plain `INSERT`s, without `ON CONFLICT`. A duplicate can only come from a bug that bypassed the lock.
  - Such a duplicate raises a unique violation. The simulator then rolls back, re-reads the stored row, returns it, and logs `ledger_lock_bypassed`.
  - Even a protocol bug therefore cannot create a second row, and it becomes visible.
  - Uniqueness alone would also keep storage safe. The lock is what makes "decide after reading" correct and gives the race an order that tests can observe through `pg_locks`.
- **The lock key:** this is the two-number form of advisory lock, in a namespace constant of the simulator's own. It cannot collide with the migration runner's single-number lock. Two orders whose ids hash to the same value only wait on each other. They never share a ledger row.
- **Repeated requests:**
  - any call after an outcome is recorded returns that outcome with `replayed: true`;
  - a repeated `charge` with `pm_card_unavailable` records nothing, so it is decided again and returns the same error;
  - if a repeated `charge` carries a different amount, the stored outcome is returned and `amount_mismatch` is logged. Order totals never change, so this would only happen through a bug.
- **Concurrent requests:** any mix of concurrent `charge` and `lookupOrVoid` calls for one order produces exactly one ledger row, and every caller receives its outcome.
- **Lookup failures:** the in-process simulator has no way to fail a `lookupOrVoid`. Tests use a controllable fake provider for lookup errors, and M5 can add them as faults.

## Failure recovery: crash after a successful payment

| Step | Event                                                                                                                  | State afterwards                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1    | Worker W1 claims the order with token 1. It reserves inventory, and the same commit increments `charge_attempts` to 1. | `processing`, claims 1, charge attempts 1, stock reduced, `inventory_reserved_at` set to time T1. |
| 2    | Under the per-order lock, the simulator records an approved row with reference R1 and commits.                         | Exactly one ledger row.                                                                           |
| 3    | W1 crashes before finalizing.                                                                                          | Still `processing`.                                                                               |
| 4    | After `CLAIM_TIMEOUT_MS`, recovery returns the order to `pending` with backoff. Counters and inventory are untouched.  | `pending`, `last_error = 'claim_expired'`, claim columns null.                                    |
| 5    | Worker W2 claims with token 2. The reservation is already made, so W2 runs the fenced charge increment.                | `processing`, claims 2, charge attempts 2. Stock not reduced again.                               |
| 6    | W2 calls `charge`. Under the lock, the simulator finds R1 and returns it with `replayed: true`, inserting nothing.     | Still one ledger row.                                                                             |
| 7    | W2 finalizes with token 2.                                                                                             | `paid`, `payment_reference = R1`.                                                                 |

**Variants:**

- **The worker was only stalled:** every write W1 attempts with token 1 after step 4 matches no row. W1 logs `claim_lost`.
- **Crash after the last allowed charge attempt:** the next claim is a reconciliation pass, because `charge_attempts = MAX_CHARGE_ATTEMPTS`. `lookupOrVoid` returns R1, and the order becomes `paid`.
- **Approval recorded, but the worker timed out on the last attempt:** reconciliation in the same pass finds R1, and the order becomes `paid`.
- **Shutdown instead of a crash:** the shutdown release replaces step 4, and steps 5 to 7 are the same.

**Deterministic reproduction:** the test runs claim, reservation and the real simulator's `charge`, then stops. It ages the claim with `UPDATE orders SET claimed_at = claimed_at - interval '1 hour'`, runs recovery once with zero delays, then runs one normal pass. No step depends on sleeps.

## Database changes

Migration `002_catalog_and_order_processing.sql`. The statements are listed in the order they run.

1. **M1 rows:** orders without items, which only exist in dev volumes, are set to `failed` with `failure_reason = 'invalid_order'` and `failed_at = now()`, and their claim columns are cleared. This happens first, so the new constraints and the trigger are satisfied.
2. **`products`:** `id uuid`, `sku text UNIQUE`, `name`, `price_cents integer CHECK >= 0`, `currency char(3)`, `stock_available integer CHECK >= 0`, and timestamps.
3. **`order_items`:** `order_id`, `product_id`, `quantity CHECK 1..100`, and `unit_price_cents`. The primary key is `(order_id, product_id)`.
4. **New `orders` columns:**
   - `payment_method`, `idempotency_key UNIQUE`, `request_hash`;
   - `next_attempt_at timestamptz NOT NULL DEFAULT now()`;
   - `charge_attempts` and `reconciliation_attempts`, both `integer NOT NULL DEFAULT 0`;
   - `inventory_reserved_at`, `inventory_released_at`, `failure_reason`, `payment_reference`, `paid_at`, `failed_at`.
5. **`orders` constraints:**
   - `status IN ('pending', 'processing', 'paid', 'failed', 'payment_unknown')`;
   - the counters are each at least 0, and `charge_attempts <= processing_attempts`;
   - claim columns are both set when the status is `processing`, and both null otherwise;
   - `charge_attempts = 0 OR inventory_reserved_at IS NOT NULL`;
   - `inventory_released_at IS NULL OR (status = 'failed' AND inventory_reserved_at IS NOT NULL)`;
   - `status <> 'payment_unknown' OR reconciliation_attempts >= 1`;
   - a `paid` order must have `payment_reference` and `paid_at`;
   - a `failed` order must have `failure_reason`, from the allowed list, and `failed_at`.
6. **Indexes:**
   - the claim index `(next_attempt_at, created_at) WHERE status IN ('pending', 'payment_unknown')` replaces the M1 pending index;
   - `(claimed_at) WHERE status = 'processing'` for recovery;
   - `order_items (product_id)`.
7. **The status-transition trigger,** matching the lifecycle table.
8. **`payment_charges`:** `order_id PRIMARY KEY`, `outcome CHECK IN ('approved', 'declined', 'voided')`, `reference`, which is required unless the outcome is `voided`, `amount_cents`, and `created_at`.

**Seed:** `pnpm db:seed` and a Compose `seed` one-shot service that runs after `migrate`.

- It inserts exactly 1,000 products, `SKU-00001` to `SKU-01000`. Names, prices and stock come from pure functions of the index.
- Every 100th SKU has stock 3, so `out_of_stock` can actually happen.
- It inserts only missing SKUs, so rerunning it never resets live stock.

## API contracts

All errors use one shape: `{ "error": "<code>", "message": "...", "details"?: [...] }`. Request bodies are parsed with Zod in the handler, without a new type-provider dependency.

**`GET /products?limit=50&after=SKU-00050`**

- Keyset pagination by SKU. `limit` is 1 to 100, default 50.
- Returns 200 with `{ items: [{ sku, name, priceCents, currency, stockAvailable }], nextCursor: string | null }`.
- Returns 400 `validation_error`.

**`POST /orders`**

- Optional header: `Idempotency-Key`, 1 to 128 visible characters.
- Body:

  ```json
  { "items": [{ "sku": "SKU-00042", "quantity": 2 }], "paymentMethod": "pm_card_ok" }
  ```

  - 1 to 50 items with unique SKUs, quantity 1 to 100.
  - `paymentMethod` must be one of the three test tokens.
  - Unknown fields are rejected.

- Returns 201 with the order and `Location: /orders/{id}`.
- The order and its items are written in one transaction. Prices are read in that same transaction.
- Stock is **not** checked here. Reservation is asynchronous, so an accepted order can still fail with `out_of_stock`. This is deliberate, realistic, and a useful incident surface.
- Same `Idempotency-Key` and same body: 200 with the original order and `Idempotent-Replayed: true`. A concurrent duplicate is resolved through the unique constraint.
- Same key with a different body: 409 `idempotency_key_conflict`.
- Malformed JSON or schema violations: 400 `validation_error`. Unknown SKUs: 422 `unknown_product`, with the SKUs listed.

**`GET /orders/:id`**

- Returns 200 with the order.
- Returns 400 `validation_error` when the id is not a UUID, and 404 `order_not_found` when no order has that id.

**Order representation:**

```json
{
  "id": "…",
  "status": "paid",
  "currency": "USD",
  "totalCents": 3998,
  "items": [
    {
      "sku": "SKU-00042",
      "name": "…",
      "quantity": 2,
      "unitPriceCents": 1999,
      "lineTotalCents": 3998
    }
  ],
  "paymentMethod": "pm_card_ok",
  "paymentReference": "sim_…",
  "processingAttempts": 1,
  "chargeAttempts": 1,
  "reconciliationAttempts": 0,
  "nextAttemptAt": null,
  "failureReason": null,
  "lastError": null,
  "createdAt": "…",
  "updatedAt": "…",
  "paidAt": "…",
  "failedAt": null
}
```

M2 is USD only, so an order's currency is always `USD`.

`status` is one of `pending`, `processing`, `paid`, `failed`, or `payment_unknown`. A future UI can show `payment_unknown` as "payment being verified".

| Field                    | Meaning                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `processingAttempts`     | Number of claims. It includes passes interrupted by crashes or shutdowns.                    |
| `chargeAttempts`         | Charge requests that may have reached the provider. It is at most `MAX_CHARGE_ATTEMPTS`.     |
| `reconciliationAttempts` | Payment lookups that failed.                                                                 |
| `nextAttemptAt`          | When a `pending` or `payment_unknown` order is next due. It is `null` in every other status. |

## Code placement

- **`packages/db`:** the migration, seed, and data-access functions. These are claim, reserve, charge increment, finalize, recover, release, create, get, and list products. All order SQL stays here.
- **`apps/orders-api`:** routes, Zod request schemas, response mapping, and pricing. Pricing is a pure function that sums the line totals.
- **`apps/worker`:**
  - the lifecycle as pure functions: the transition table, pass selection, and the charge, recovery and reconciliation backoff;
  - the capacity-aware loop, which claims only for free slots;
  - the processor, which runs the protocol above, including reconciliation;
  - the shutdown coordinator, with drain, abort, release, and exit-code decision;
  - the payment simulator interface and its implementation, including the per-order ledger lock;
  - test seams: an injectable provider, an injectable drain-deadline trigger, and hooks the loop calls on each claim and each pass start. Tests use these instead of timers.
- **New worker settings:**
  - `WORKER_CONCURRENCY` and `CLAIM_TIMEOUT_MS`;
  - `DB_CONNECT_TIMEOUT_MS` and `DB_STATEMENT_TIMEOUT_MS`;
  - `PAYMENT_TIMEOUT_MS` and `PAYMENT_LATENCY_MS`;
  - `MAX_CLAIMS`, `MAX_CHARGE_ATTEMPTS` and `MAX_RECONCILIATION_ATTEMPTS`;
  - `RETRY_BASE_DELAY_MS` and `RETRY_MAX_DELAY_MS`;
  - `RECONCILIATION_BASE_DELAY_MS`, `RECONCILIATION_MAX_DELAY_MS` and `PAYMENT_UNKNOWN_RECHECK_MS`.

  `MAX_CHARGE_ATTEMPTS` replaces the earlier `MAX_PROCESSING_ATTEMPTS`. Startup validation requires `MAX_CLAIMS > MAX_CHARGE_ATTEMPTS`.

- No new workspace package. The lifecycle has one consumer, the worker. The API only creates `pending` orders.
- **New dev dependency:** `@vitest/coverage-v8`, needed to measure the coverage criterion. No new runtime dependencies.
- **ADR 0005** records the processing protocol: slot-based claiming, the three counters and fencing, transaction boundaries, the per-order ledger lock, `lookupOrVoid` reconciliation, `payment_unknown`, the shutdown protocol, and the transition trigger.

## Acceptance criteria

Each criterion is marked with how it is checked.

- **[D] deterministic:** integration or unit tests against Postgres. They synchronize on events: barriers in a controllable fake provider, hooks the loop calls on each claim and pass start, an injectable drain-deadline trigger, and row locks held by the test. They control time by updating timestamps in SQL and building dependencies with zero delays. A [D] test never asserts on wall-clock durations. A generous test timeout only turns a hang into a failure.
- **[E2E] end-to-end:** real processes and real time, with generous bounds.

Criteria 1 to 31 keep their numbers. Revised in this revision: 4, 7, 12, 13, 18, 19, 20, 21, 24, 26, 27, 28, 29 and 30. New: 32 to 36.

### Core flow

1. [E2E] All M1 checks still pass: health, readiness during database loss, graceful shutdown, migration rerun, and config failure.
2. [D] Seeding is deterministic. Two seeds into fresh databases produce exactly 1,000 products with identical content checksums. A second seed changes nothing.
3. [D] `POST /orders` returns 201 with the correct total and `Location`. `GET /orders/{id}` returns the same order.
4. [D] _Revised._ A `pm_card_ok` order processed by one pass is `paid`, with `processingAttempts = 1`, `chargeAttempts = 1` and `nextAttemptAt = null`. Stock drops by exactly the ordered quantity.
5. [D] A `pm_card_declined` order ends `failed` with `payment_declined`, and stock returns to its original value. `inventory_released_at` is set.
6. [D] Ordering more than the available stock ends `failed` with `out_of_stock`. Stock is unchanged, `charge_attempts = 0`, and `inventory_released_at` is null.
7. [D] _Revised._ A `pm_card_unavailable` order:
   - calls `charge` exactly `MAX_CHARGE_ATTEMPTS` times, with the charge backoff stored in `next_attempt_at` each time;
   - then reconciles in the same pass, and `lookupOrVoid` records `voided`;
   - ends `failed` with `max_attempts_exceeded`, `chargeAttempts = MAX_CHARGE_ATTEMPTS`, and one `voided` ledger row;
   - has its stock released exactly once.
8. [D] Idempotency: a repeated request with the same key and body returns the same order id, and only one row exists. The same key with a different body returns 409.
9. [D] Validation:
   - 400 for an empty item list, quantity 0 or 101, duplicate SKUs, an unknown payment method, unknown fields, malformed JSON, and a non-UUID id;
   - 422 for unknown SKUs;
   - 404 for a missing order.
10. [D] Concurrency: two workers process 200 orders with mixed payment methods.
    - Every order ends terminal.
    - Each `paid` order has exactly one `approved` ledger row with a matching reference.
    - Stock never goes negative, and the stock sold equals the quantities of the paid orders.
11. [D] Stale claims:
    - an expired claim returns the order to `pending` with `last_error = 'claim_expired'`. Recovery never sets `failed`, and never changes stock or counters;
    - the order is then completed;
    - the stale worker's late writes change nothing;
    - there is no second charge.
12. [D] _Revised._ The trigger and constraints, tested with raw SQL:
    - **rejected:** `paid` to `pending`, `failed` to `processing`, `payment_unknown` to `failed`, `payment_unknown` to `paid`, and `payment_unknown` to `pending`;
    - **also rejected:** `processing` without claim columns, `pending` with claim columns, `charge_attempts > 0` without a reservation, `inventory_released_at` on a non-failed order, and `payment_unknown` with `reconciliation_attempts = 0`;
    - **accepted:** every transition in the lifecycle table, and same-status updates.
13. [D] _Revised._ Line coverage is at least 80% for the lifecycle, pass selection, backoff, pricing, capacity, processor, reconciliation, shutdown and simulator modules.
14. [E2E] With `docker compose up --build --wait`, an order placed with curl is `paid` within 5 s.
15. [E2E] `docker compose stop -t 10 worker` while orders are in flight under default config:
    - the worker exits with code 0 within 10 s;
    - its logs show no claim after shutdown started;
    - afterwards, no order is left in `processing`.
16. [D] Format check, lint, typecheck, build, and tests pass from a clean copy.

### Claim capacity

17. [D] **Capacity rule, unit test.** The test drives the worker loop with a fake claim function and order handlers that it resolves manually. It asserts that:
    - the claim limit always equals `min(WORKER_CONCURRENCY - inFlight, CLAIM_BATCH_SIZE)`;
    - no claim is sent while `inFlight = WORKER_CONCURRENCY`;
    - after a handler resolves, the next claim is sent before the loop waits on its poll timer;
    - every claimed order's handler is invoked synchronously, before the loop awaits anything else.
18. [D] _Revised._ **Orders wait unclaimed for capacity, then run without queueing.** This integration test uses Postgres, the real loop and processor, and a fake provider whose `charge` calls block until the test releases them one by one. The setup:
    - `WORKER_CONCURRENCY = 2`, 6 `pm_card_ok` orders, and `CLAIM_TIMEOUT_MS` of 1 hour, with recovery running on every poll;
    - a poll interval of 1 hour;
    - claim and pass-start hooks that record ids.

    Then:
    1. Wait for the event "2 charges started".
    2. Assert:
       - the claim hook returned exactly 2 ids, and the pass-start hook has the same 2;
       - Postgres shows those 2 as `processing` and the other 4 as `pending`, with claim columns null and `processing_attempts = 0`.
    3. Run recovery. It changes nothing.
    4. Release one charge. Wait for the event "3rd charge started", then assert 1 `paid`, 2 `processing`, and 3 unclaimed.
    5. Repeat until all 6 are `paid`.

    Final state:
    - every order has `processing_attempts = 1`, `charge_attempts = 1` and `last_error` null;
    - there are 6 `approved` ledger rows, and stock is reduced exactly by the ordered quantities;
    - at most 2 charges were blocked at once.

    The proof is structural: waiting orders never hold a claim, so they cannot lose one. Time-based expiry is covered by criteria 11 and 25.

19. [D] _Revised._ **Startup validation.** The worker refuses to start, and names the setting, when any of these holds:
    - `CLAIM_TIMEOUT_MS < 1.5 × (2C + 11S + 2P)`. The message shows the computed budget;
    - `MAX_CLAIMS <= MAX_CHARGE_ATTEMPTS`;
    - any delay is below its minimum: retry 100 ms, reconciliation 1 s, recheck 60 s.

### Crash after a successful payment

These follow "Failure recovery: crash after a successful payment".

20. [D] _Revised._ **Crash after approval, then recovery.** Final state:
    - exactly one ledger row;
    - `paid`, with `processing_attempts = 2` and `charge_attempts = 2`;
    - the second `charge` returned `replayed: true` with R1, and the order's `payment_reference` is R1;
    - stock reduced exactly once, and `inventory_reserved_at` unchanged from the first attempt;
    - a finalize issued afterwards with token 1 updates 0 rows.
21. [D] _Revised._ **Crash after the last allowed charge attempt:**
    - with `charge_attempts = MAX_CHARGE_ATTEMPTS`, recovery and the next claim lead to a reconciliation pass that makes no `charge` call and no reservation statement;
    - `lookupOrVoid` returns R1 and records no void;
    - the order is `paid`, with `charge_attempts = MAX_CHARGE_ATTEMPTS`;
    - there is one ledger row, and stock was reduced once.
22. [D] **Approval recorded, then a timeout on the last attempt.** A fake provider wraps the real simulator, records the charge, then reports a timeout. Reconciliation in the same pass gets R1, and the order is `paid`, not `failed`. There is one ledger row, and stock is reduced once.

### Shutdown

23. [D] **SIGTERM with an order in flight.** The fake provider blocks one charge, and the test calls the worker's shutdown function.
    - No further claim is sent, even though pending orders exist and a slot is free.
    - The test releases the charge before triggering the drain deadline.
    - The order ends `paid`, and the shutdown result is "exit code 0".
24. [D] _Revised._ **Charge recorded immediately before shutdown.**
    - The fake provider wraps the real simulator. It records an approval, then never answers. The test triggers the drain deadline.
    - Afterwards the order is `pending`, with `last_error = 'released_on_shutdown'` and claim columns null.
    - Its counters are `processing_attempts = 1` and `charge_attempts = 1`. `inventory_reserved_at` is set, and `inventory_released_at` is null.
    - There is one `approved` ledger row, and the shutdown result is "exit code 0".
    - A new pass gets `replayed: true`, and the order is `paid` with the original reference.
25. [D] **Stale worker after recovery.**
    - W1's charge is blocked. The test ages the claim and runs recovery, then W2 claims and completes the order with token 2.
    - The test releases W1's charge. W1's finalize and a release attempted with W1's token both update 0 rows, and W1 logs `claim_lost`.
    - The order keeps W2's state and `updated_at`. There is one ledger row, and stock was reduced once.

### Lookup failures and `payment_unknown`

These use a fake provider whose `lookupOrVoid` returns a scripted sequence. `charge` calls and reservation statements are counted.

26. [D] _Revised._ **A lookup error before the limit.**
    - The order is `pending`, with `reconciliation_attempts = 1` and `charge_attempts` unchanged.
    - `next_attempt_at - updated_at` equals the first reconciliation backoff exactly, because both are set in one statement.
    - Stock is still reserved, and `inventory_released_at` is null.
    - The next claim is a reconciliation pass: no `charge` call and no reservation statement.
27. [D] _Revised._ **Repeated lookup errors at the limit.** After `MAX_RECONCILIATION_ATTEMPTS` errors, with `next_attempt_at` reset to `now()` between passes:
    - the order is `payment_unknown`, and `next_attempt_at - updated_at` equals `PAYMENT_UNKNOWN_RECHECK_MS`;
    - `GET /orders/:id` returns `status: "payment_unknown"`, `reconciliationAttempts`, `lastError` and `nextAttemptAt`;
    - stock is still reserved, and there were no `charge` calls;
    - before it is due, a claim returns nothing for this order. Once due, with another scripted error, exactly one lookup happens, and the order is back in `payment_unknown` with the next recheck due.
28. [D] _Revised._ **A later lookup finds an approved charge.** From `payment_unknown`, the next scripted result is `approved` with reference R.
    - The order becomes `paid` with R.
    - No reservation statement ran in that pass, and stock is unchanged by it, so it was reduced exactly once overall.
    - `inventory_released_at` is null.
29. [D] _Revised._ **A later lookup authoritatively finds no charge.** This uses the real simulator, after scripted errors. `lookupOrVoid` records `voided`.
    - The order is `failed` with `max_attempts_exceeded`.
    - Stock returns to its initial value once, and `inventory_released_at` is set.
    - There is one `voided` ledger row.
    - A later `charge` for the order returns `voided` and inserts nothing.
30. [D] _Revised._ **Workers racing over the same order.**
    - Two recovery calls run concurrently on one expired order. Exactly one updates it.
    - Two claimers run concurrently on one due `payment_unknown` order. Exactly one gets it, and only one lookup happens.
    - Ledger races are covered by criterion 32.
31. [D] **Inventory is released at most once, and only on `failed`.** Every test in this list also checks this through `inventory_released_at` and stock.

### Ledger serialization

32. [D] **Charge versus void.** This runs against the real simulator. The test holds the per-order advisory lock in its own transaction. It then orders the waiters by checking `pg_locks`.
    - **Charge first:** the test starts `charge` with `pm_card_ok`, waits until `pg_locks` shows it waiting, starts `lookupOrVoid`, then releases its lock. `charge` records `approved`, `lookupOrVoid` returns that row with `replayed: true`, and there is one row.
    - **Void first:** the same steps in the opposite order. `lookupOrVoid` records `voided`, `charge` returns `voided` without inserting, and there is one row.
    - **Afterwards:** in both cases, 10 more alternating calls all return the stored outcome, and the ledger still holds one row.
33. [D] **Repeated, unavailable, and duplicate requests.**
    - Sequential repeats return the stored outcome with `replayed: true`.
    - A repeated `pm_card_unavailable` charge records nothing and returns the same error each time.
    - A duplicate inserted directly in SQL, bypassing the lock, raises a unique violation. A simulator call that hits that violation returns the stored row and logs `ledger_lock_bypassed`.

### Attempt semantics

34. [D] **Shutdown releases don't spend the payment budget.**
    - A hook pauses each pass before its reservation. The test triggers shutdown release 3 times, starting a fresh worker after each.
    - The order is then `pending`, with `processing_attempts = 3` and `charge_attempts = 0`.
    - A normal pass then makes it `paid`, with `processing_attempts = 4` and `charge_attempts = 1`.
    - **Claim ceiling variant:** after `MAX_CLAIMS` such releases, the next pass is a reconciliation pass. `lookupOrVoid` records `voided`, and the order ends `failed` with `max_attempts_exceeded`, with no `charge` call ever made and no inventory released, because none was reserved.

### Shutdown release cannot get the lock

35. [D] **The release is blocked by a held row lock.**
    - The fake provider blocks a charge, so the pass's reservation is committed and `charge_attempts = 1`.
    - The test opens its own transaction and runs `SELECT ... FROM orders WHERE id = $1 FOR UPDATE`. It keeps that lock until shutdown has resolved, standing in for a statement still running server-side.
    - The test triggers the drain deadline.
    - **Exit policy:** the shutdown result is "exit code 1", with the order listed as unconfirmed. The result does not depend on the 500 ms budget elapsing, because `SKIP LOCKED` skips the held row immediately.
    - **No unsafe write:** after the test rolls back its lock, the order is unchanged. It is still `processing` with token 1 and the same `claimed_at` and counters. Stock is reserved once, nothing is released, and the ledger is unchanged.
    - **Nothing more from the aborted pass:** a spy on the data-access layer shows no write from it after the abort.
    - **Recoverable:** the test ages `claimed_at` and runs recovery. The order becomes `pending`, and a new claim issues token 2.
    - **Stale writes rejected:** a finalize with token 1 updates 0 rows, and so does a release with token 1.
    - **Completed:** the next pass gets the recorded outcome or a fresh one under the ledger lock. The order ends `paid`, with one ledger row and stock reduced once.

### `payment_unknown` coordination

36. [D] **Rechecks are single, never charge, and stay parked when interrupted.**
    - Two workers become eligible together for one due `payment_unknown` order. Exactly one claim succeeds, there is exactly one `lookupOrVoid` call, and there are no `charge` calls.
    - **Interrupted by shutdown:** the recheck's lookup is blocked, and the drain deadline fires. The release returns the order to `payment_unknown`, not `pending`. `next_attempt_at - updated_at` equals `PAYMENT_UNKNOWN_RECHECK_MS`, and inventory is unchanged.
    - **Interrupted by a crash:** the claim is aged and recovery runs. The order goes to `payment_unknown` with the same due-time rule.

### Timing checks (informational, not acceptance-blocking)

- **T1.** Under Compose with default config, 200 mixed orders all reach a terminal state within 60 s. The report shows throughput and the median and p95 time from claim to charge start.
