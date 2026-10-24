import { isSpanContextValid, trace } from '@opentelemetry/api';

/**
 * pino mixin: adds `trace_id` and `span_id` when a valid span is active, and nothing otherwise.
 * With telemetry disabled the OpenTelemetry API is a no-op, so this always returns {}.
 */
export function traceLogMixin(): { trace_id?: string; span_id?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}
