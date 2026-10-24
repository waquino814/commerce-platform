import {
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Link,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';

export type { Attributes, Span };

const TRACER_NAME = '@commerce/telemetry';
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * W3C traceparent of the active span, or null when no valid span is active (telemetry off, or
 * outside a span). Stored on the order at creation so later passes can link back to it.
 */
export function currentTraceparent(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return null;
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags.toString(16).padStart(2, '0')}`;
}

/** Parses a stored traceparent into a remote span context, or null if absent or invalid. */
export function parseTraceparent(value: string | null | undefined): SpanContext | null {
  const match = TRACEPARENT.exec(value ?? '');
  if (!match) return null;
  const [, traceId = '', spanId = '', flags = '00'] = match;
  const ctx: SpanContext = { traceId, spanId, traceFlags: parseInt(flags, 16), isRemote: true };
  return isSpanContextValid(ctx) ? ctx : null;
}

/**
 * The link from a worker-side span back to the order's creation trace. When the order has no
 * usable stored context, there is no link and the span is marked `order.trace_context_missing`.
 */
export function creationLink(
  traceContext: string | null | undefined,
  orderId: string,
): { links: Link[]; attributes: Attributes } {
  const ctx = parseTraceparent(traceContext);
  if (!ctx) return { links: [], attributes: { 'order.trace_context_missing': true } };
  return {
    links: [{ context: ctx, attributes: { 'order.link': 'created', 'order.id': orderId } }],
    attributes: {},
  };
}

export interface WithSpanOptions {
  attributes?: Attributes;
  kind?: 'internal' | 'consumer';
  links?: Link[];
  /** Start a new trace instead of a child of the active span. Used for every worker pass. */
  root?: boolean;
}

/**
 * Runs `fn` inside a new active span and ends the span when `fn` settles. A thrown error is
 * recorded on the span, which is marked ERROR, and rethrown. `fn` starts synchronously.
 * With `root: true` the span's parent is the empty root context, never whatever was active, so
 * one order's context can never parent another order's spans.
 */
export function withSpan<T>(
  name: string,
  options: WithSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = options.root ? ROOT_CONTEXT : context.active();
  return trace.getTracer(TRACER_NAME).startActiveSpan(
    name,
    {
      kind: options.kind === 'consumer' ? SpanKind.CONSUMER : SpanKind.INTERNAL,
      ...(options.attributes ? { attributes: options.attributes } : {}),
      ...(options.links ? { links: options.links } : {}),
    },
    parent,
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        markSpanError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** Marks a span ERROR, recording the error as an exception event when it is an Error. */
export function markSpanError(span: Span, err: unknown): void {
  if (err instanceof Error) span.recordException(err);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err instanceof Error ? err.message : String(err),
  });
}

/** Sets attributes on the active span, if any. A no-op with telemetry off. */
export function annotateActiveSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

export interface SweepItem {
  orderId: string;
  traceContext: string | null;
  /** Extra attributes for this order's child span; `order.id` is always set. */
  attributes?: Attributes;
}

/**
 * Records one completed sweep (claim recovery or shutdown release) as a root span with one child
 * span per affected order. Each child links to that order's creation trace (one link per span,
 * so the SDK's per-span link limit never drops any), and `onItem` runs inside the child's
 * context so its log line carries the sweep's trace id and the child's span id. A sweep that
 * affected nothing records nothing.
 */
export function recordSweep(options: {
  name: string;
  childName: string;
  /** When the sweep began, in epoch milliseconds, taken before its statement ran. */
  startTime: number;
  attributes: Attributes;
  items: readonly SweepItem[];
  onItem?: (item: SweepItem) => void;
}): void {
  if (options.items.length === 0) return;
  const tracer = trace.getTracer(TRACER_NAME);
  const root = tracer.startSpan(
    options.name,
    { root: true, startTime: options.startTime, attributes: options.attributes },
    ROOT_CONTEXT,
  );
  const rootContext = trace.setSpan(ROOT_CONTEXT, root);
  for (const item of options.items) {
    const link = creationLink(item.traceContext, item.orderId);
    const child = tracer.startSpan(
      options.childName,
      {
        links: link.links,
        attributes: { ...item.attributes, ...link.attributes, 'order.id': item.orderId },
      },
      rootContext,
    );
    context.with(trace.setSpan(rootContext, child), () => options.onItem?.(item));
    child.end();
  }
  root.end();
}
