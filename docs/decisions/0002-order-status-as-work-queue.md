# 0002: Order status as the work queue

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

The worker exists to process placed orders: reserve inventory and simulate payment. A common pattern is a generic `jobs` table with a type and JSON payload. That adds an abstraction the domain does not need yet, and it hides order state behind an opaque payload, which makes incidents harder to read.

## Decision

The `orders` table is the unit of work. The worker claims `pending` orders with `FOR UPDATE SKIP LOCKED` and records claim state on the order itself: `status`, `claimed_by`, `claimed_at`, `processing_attempts`, and `last_error`. There is no generic job framework, no job types, and no payload column.

## Consequences

- **Positive:** One table shows both business state and processing state. Stuck or retried orders are visible with one query, and so are the incidents built on them.
- **Positive:** Placing an order is a single insert, so no outbox or second write is needed.
- **Negative:** Adding a different kind of background work, such as notifications, needs its own table or a revisit of this decision.
- **Negative:** Claim columns sit next to business columns on a hot table. That contention is acceptable here and also a realistic source of incidents.
- **Revisit if:** a second, independent kind of background work is needed, or per-order processing grows into multiple steps with separate retries.
