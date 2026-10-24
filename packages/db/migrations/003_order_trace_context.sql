-- M3b: the W3C traceparent of the span that created the order (docs/prompts/m3-design.md).
-- Additive and nullable: orders created before M3, or with telemetry off, have none.
ALTER TABLE orders
  ADD COLUMN trace_context text
    CONSTRAINT orders_trace_context_check
    CHECK (trace_context IS NULL OR trace_context ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
