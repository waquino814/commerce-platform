# 0005: Order processing protocol

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

M2 turns the worker from a claimer into a payment processor. The system must survive concurrent workers, crashes, shutdowns, provider timeouts, and provider outages without double charging, overselling, or releasing stock for goods that were paid for. The full specification is `docs/prompts/m2-design.md`. This record captures the decisions it rests on.

## Decision

- **Slot-based claiming.** A worker claims only as many orders as it has free processing slots, and starts each one in the same event-loop turn. No claimed order waits in memory, so waiting orders hold no claim that could expire.
- **Three counters.**
  - `processing_attempts` counts claims and is the fencing token.
  - `charge_attempts` counts charge requests and is the payment retry budget.
  - `reconciliation_attempts` counts failed lookups.

  Shutdowns and crashes spend claims, not the payment budget. A claim ceiling bounds orders that never get charged.

- **Fencing.** Every worker write to an order requires `status = 'processing'` and the pass's token. Recovery and shutdown release hold no token. They are single statements that re-check their predicate under `SKIP LOCKED`.
- **Transaction boundaries.**
  - Reservation is one transaction that also records the first charge attempt.
  - Finalizing to `failed` releases stock in the same transaction.
  - No connection or lock is held during a provider call.
  - Product rows are always locked in SKU order.
- **Provider protocol.** The simulator serializes every `charge` and `lookupOrVoid` for an order with a transaction-scoped advisory lock: read, decide and record under the lock. A void permanently blocks a later charge. The ledger's primary key is a backstop that logs any bypass.
- **Uncertainty is never "no charge".** A provider error or timeout is unknown. After the charge budget, an order is only reconciled with `lookupOrVoid`. Lookup errors back off and finally park the order in `payment_unknown`, which keeps its stock reserved and is rechecked on a long interval.
- **Database enforcement.** A trigger enforces the transition table. Constraints enforce:
  - claim columns set if and only if the order is `processing`;
  - a charge only after a reservation;
  - a stock release only on `failed`;
  - required fields on terminal states.
- **Shutdown.** Stop claiming, drain for 7 s, abort the remaining passes without writing, then release their claims with one fenced statement that skips locked rows. Exit code 1 means a release was unconfirmed, and recovery will requeue those orders.

## Consequences

- **Positive:** Each failure mode has one defined outcome, and that outcome is enforced by both code and the database. The acceptance suite covers each one deterministically.
- **Positive:** The states and counters are visible through the API. They make incidents legible for the Engineering Operations AI Agent.
- **Negative:** The schema carries three counters, ten constraints and a trigger, which raises migration and test effort.
- **Negative:** The simulator holds a transaction for its simulated latency. Under M5 latency faults, waiting for the lock counts toward the payment timeout.
- **Negative:** A void is final, so a customer whose payment outcome could not be confirmed must place a new order.
- **Revisit if:** a real external provider is added, or per-order processing gains more steps with separate retries.
