import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isProbePath, nameServerSpan } from '../src/http.js';

describe('isProbePath (criterion 4)', () => {
  it.each([
    ['/healthz', true],
    ['/readyz', true],
    ['/readyz?verbose=1', true],
    ['/orders', false],
    ['/healthz/extra', false],
    [undefined, false],
  ])('%s -> %s', (url, expected) => {
    expect(isProbePath(url)).toBe(expected);
  });
});

describe('nameServerSpan', () => {
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

  it('names the active span after the route template and sets http.route', () => {
    trace.getTracer('t').startActiveSpan('GET', (span) => {
      nameServerSpan('GET', '/orders/:id');
      span.end();
    });
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('GET /orders/:id');
    expect(span?.attributes['http.route']).toBe('/orders/:id');
  });

  it('leaves unmatched routes alone, so a raw URL never becomes a span name', () => {
    exporter.reset();
    trace.getTracer('t').startActiveSpan('GET', (span) => {
      nameServerSpan('GET', undefined);
      span.end();
    });
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('GET');
    expect(span?.attributes).not.toHaveProperty('http.route');
  });

  it('does nothing without an active span', () => {
    expect(() => {
      nameServerSpan('POST', '/orders');
    }).not.toThrow();
  });
});
