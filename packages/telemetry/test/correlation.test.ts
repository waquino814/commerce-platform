import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  annotateActiveSpan,
  creationLink,
  currentTraceparent,
  markSpanError,
  parseTraceparent,
  recordSweep,
  withSpan,
} from '../src/correlation.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
beforeAll(() => {
  provider.register();
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});
beforeEach(() => {
  exporter.reset();
});

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';

describe('traceparent', () => {
  it('formats the active span and returns null outside a span', async () => {
    expect(currentTraceparent()).toBeNull();
    await withSpan('order.create', {}, (span) => {
      const ctx = span.spanContext();
      expect(currentTraceparent()).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
      return Promise.resolve();
    });
  });

  it('parses valid values and rejects malformed or all-zero ones', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      traceFlags: 1,
      isRemote: true,
    });
    for (const bad of [
      null,
      undefined,
      '',
      `01-${TRACE}-${SPAN}-01`,
      `00-${TRACE.toUpperCase()}-${SPAN}-01`,
      `00-${'0'.repeat(32)}-${SPAN}-01`,
      `00-${TRACE}-${'0'.repeat(16)}-01`,
      `00-${TRACE}-${SPAN}`,
    ]) {
      expect(parseTraceparent(bad)).toBeNull();
    }
  });

  it('builds a creation link, or marks the context missing', () => {
    const { links, attributes } = creationLink(`00-${TRACE}-${SPAN}-01`, 'order-1');
    expect(attributes).toEqual({});
    expect(links).toEqual([
      {
        context: { traceId: TRACE, spanId: SPAN, traceFlags: 1, isRemote: true },
        attributes: { 'order.link': 'created', 'order.id': 'order-1' },
      },
    ]);
    expect(creationLink(null, 'order-2')).toEqual({
      links: [],
      attributes: { 'order.trace_context_missing': true },
    });
  });
});

describe('withSpan', () => {
  it('nests by default, and starts a new trace with root: true even inside another span', async () => {
    await withSpan('outer', {}, async () => {
      await withSpan('child', {}, () => Promise.resolve());
      await withSpan('pass', { root: true, kind: 'consumer' }, () => Promise.resolve());
    });
    const spans = exporter.getFinishedSpans();
    const outer = spans.find((s) => s.name === 'outer');
    const child = spans.find((s) => s.name === 'child');
    const pass = spans.find((s) => s.name === 'pass');
    expect(child?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
    expect(pass?.parentSpanContext).toBeUndefined();
    expect(pass?.spanContext().traceId).not.toBe(outer?.spanContext().traceId);
    expect(pass?.kind).toBe(SpanKind.CONSUMER);
    expect(outer?.kind).toBe(SpanKind.INTERNAL);
  });

  it('starts fn synchronously, records thrown errors as ERROR, and rethrows', async () => {
    let started = false;
    const running = withSpan('sync', {}, () => {
      started = true;
      return Promise.resolve();
    });
    expect(started).toBe(true);
    await running;
    await expect(
      withSpan('boom', { attributes: { a: 1 } }, () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    const boom = exporter.getFinishedSpans().find((s) => s.name === 'boom');
    expect(boom?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'x' });
    expect(boom?.events.map((e) => e.name)).toEqual(['exception']);
    expect(boom?.attributes).toEqual({ a: 1 });
  });

  it('markSpanError handles non-Error values, and annotateActiveSpan is a no-op outside a span', async () => {
    annotateActiveSpan({ ignored: true });
    await withSpan('marked', {}, async (span) => {
      annotateActiveSpan({ 'order.id': 'o-1' });
      markSpanError(span, 'pass aborted');
      return Promise.resolve();
    });
    const marked = exporter.getFinishedSpans().find((s) => s.name === 'marked');
    expect(marked?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'pass aborted' });
    expect(marked?.attributes).toEqual({ 'order.id': 'o-1' });
    expect(marked?.events).toEqual([]);
  });
});

describe('recordSweep', () => {
  it('records nothing for an empty sweep', () => {
    recordSweep({
      name: 'worker.recover_claims',
      childName: 'c',
      startTime: Date.now(),
      attributes: {},
      items: [],
    });
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('records one root and one linked child per item, running onItem inside each child', () => {
    const seen: { orderId: string; traceId?: string; spanId?: string }[] = [];
    const startTime = Date.now() - 1000;
    context.with(trace.setSpan(ROOT_CONTEXT, trace.getTracer('t').startSpan('unrelated')), () => {
      recordSweep({
        name: 'worker.recover_claims',
        childName: 'order.claim_recovered',
        startTime,
        attributes: { 'claims.recovered': 2 },
        items: [
          {
            orderId: 'a',
            traceContext: `00-${TRACE}-${SPAN}-01`,
            attributes: { 'order.status': 'pending' },
          },
          { orderId: 'b', traceContext: null },
        ],
        onItem: (item) => {
          const ctx = trace.getActiveSpan()?.spanContext();
          seen.push({
            orderId: item.orderId,
            ...(ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : {}),
          });
        },
      });
    });
    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === 'worker.recover_claims');
    const children = spans.filter((s) => s.name === 'order.claim_recovered');
    expect(root?.parentSpanContext).toBeUndefined();
    expect(root?.attributes).toEqual({ 'claims.recovered': 2 });
    expect(root?.startTime[0]).toBe(Math.floor(startTime / 1000));
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
      expect(child.spanContext().traceId).toBe(root?.spanContext().traceId);
    }
    const a = children.find((c) => c.attributes['order.id'] === 'a');
    const b = children.find((c) => c.attributes['order.id'] === 'b');
    expect(a?.attributes).toEqual({ 'order.id': 'a', 'order.status': 'pending' });
    expect(a?.links[0]?.context.traceId).toBe(TRACE);
    expect(a?.links[0]?.attributes).toEqual({ 'order.link': 'created', 'order.id': 'a' });
    expect(b?.links).toEqual([]);
    expect(b?.attributes).toEqual({ 'order.id': 'b', 'order.trace_context_missing': true });
    expect(seen).toEqual([
      { orderId: 'a', traceId: root?.spanContext().traceId, spanId: a?.spanContext().spanId },
      { orderId: 'b', traceId: root?.spanContext().traceId, spanId: b?.spanContext().spanId },
    ]);
  });
});
