-- M2: catalog, order items, order processing state, and the payment simulator's ledger.
-- See docs/prompts/m2-design.md ("Database changes") and ADR 0005.

-- 1. New order columns. They come first because step 2 writes to them.
ALTER TABLE orders
  ADD COLUMN payment_method          text,
  ADD COLUMN idempotency_key         text UNIQUE,
  ADD COLUMN request_hash            text,
  ADD COLUMN next_attempt_at         timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN charge_attempts         integer     NOT NULL DEFAULT 0,
  ADD COLUMN reconciliation_attempts integer     NOT NULL DEFAULT 0,
  ADD COLUMN inventory_reserved_at   timestamptz,
  ADD COLUMN inventory_released_at   timestamptz,
  ADD COLUMN failure_reason          text,
  ADD COLUMN payment_reference       text,
  ADD COLUMN paid_at                 timestamptz,
  ADD COLUMN failed_at               timestamptz;

-- 2. M1 orders have no items (order_items does not exist yet). They only exist in dev volumes.
--    Fail them before the new constraints and the transition trigger are created.
UPDATE orders
   SET status = 'failed', failure_reason = 'invalid_order', failed_at = now(),
       claimed_by = NULL, claimed_at = NULL, updated_at = now();

-- 3. Catalog and order items.
CREATE TABLE products (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             text        NOT NULL UNIQUE,
  name            text        NOT NULL,
  price_cents     integer     NOT NULL CHECK (price_cents >= 0),
  currency        char(3)     NOT NULL DEFAULT 'USD',
  stock_available integer     NOT NULL CHECK (stock_available >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id         uuid    NOT NULL REFERENCES orders (id),
  product_id       uuid    NOT NULL REFERENCES products (id),
  quantity         integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX order_items_product_id_idx ON order_items (product_id);

-- 4. Order constraints. The status check keeps its M1 name.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
    CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'payment_unknown')),
  ADD CONSTRAINT orders_payment_method_check
    CHECK (payment_method IN ('pm_card_ok', 'pm_card_declined', 'pm_card_unavailable')),
  ADD CONSTRAINT orders_counters_check
    CHECK (charge_attempts >= 0 AND reconciliation_attempts >= 0
           AND charge_attempts <= processing_attempts),
  ADD CONSTRAINT orders_claim_columns_check
    CHECK ((status = 'processing' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
        OR (status <> 'processing' AND claimed_by IS NULL AND claimed_at IS NULL)),
  ADD CONSTRAINT orders_charge_requires_reservation_check
    CHECK (charge_attempts = 0 OR inventory_reserved_at IS NOT NULL),
  ADD CONSTRAINT orders_inventory_release_check
    CHECK (inventory_released_at IS NULL
        OR (status = 'failed' AND inventory_reserved_at IS NOT NULL)),
  ADD CONSTRAINT orders_payment_unknown_check
    CHECK (status <> 'payment_unknown' OR reconciliation_attempts >= 1),
  ADD CONSTRAINT orders_paid_check
    CHECK (status <> 'paid' OR (payment_reference IS NOT NULL AND paid_at IS NOT NULL)),
  ADD CONSTRAINT orders_failed_check
    CHECK (status <> 'failed'
        OR (failed_at IS NOT NULL
            AND failure_reason IN ('out_of_stock', 'payment_declined',
                                   'max_attempts_exceeded', 'invalid_order'))),
  ADD CONSTRAINT orders_failure_reason_check
    CHECK (failure_reason IS NULL OR status = 'failed');

-- 5. Indexes. One claim index serves both claimable statuses.
DROP INDEX orders_pending_created_at_idx;
CREATE INDEX orders_due_idx ON orders (next_attempt_at, created_at)
  WHERE status IN ('pending', 'payment_unknown');
CREATE INDEX orders_processing_claimed_at_idx ON orders (claimed_at) WHERE status = 'processing';

-- 6. Status transitions. Same-status updates (for example next_attempt_at) are allowed.
CREATE FUNCTION orders_enforce_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status, NEW.status) IN (
       ('pending', 'processing'),
       ('payment_unknown', 'processing'),
       ('processing', 'paid'),
       ('processing', 'failed'),
       ('processing', 'pending'),
       ('processing', 'payment_unknown')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal order status transition: % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER orders_status_transition
  BEFORE UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_enforce_status_transition();

-- 7. The payment simulator's ledger: the fake provider's state, one row per order.
--    No foreign key to orders: it models an external system. Only the simulator writes it.
CREATE TABLE payment_charges (
  order_id     uuid        PRIMARY KEY,
  outcome      text        NOT NULL CHECK (outcome IN ('approved', 'declined', 'voided')),
  reference    text        CHECK (outcome = 'voided' OR reference IS NOT NULL),
  amount_cents integer     CHECK (outcome = 'voided' OR amount_cents >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
