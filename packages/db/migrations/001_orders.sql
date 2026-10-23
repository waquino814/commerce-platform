-- Orders are both the business record and the unit of background work (ADR 0002).
CREATE TABLE orders (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'processing', 'paid', 'failed')),
  total_cents         integer     NOT NULL CHECK (total_cents >= 0),
  currency            char(3)     NOT NULL,
  processing_attempts integer     NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  claimed_by          text,
  claimed_at          timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Supports the worker's oldest-first claim query without scanning finished orders.
CREATE INDEX orders_pending_created_at_idx ON orders (created_at) WHERE status = 'pending';
