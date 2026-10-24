import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { traceLogMixin } from '../src/log-mixin.js';

describe('traceLogMixin (criterion 3)', () => {
  it('returns nothing when telemetry is not started', () => {
    expect(traceLogMixin()).toEqual({});
    trace.getTracer('t').startActiveSpan('noop', (span) => {
      expect(traceLogMixin()).toEqual({});
      span.end();
    });
  });

  describe('with a tracer provider', () => {
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });
    beforeAll(() => {
      provider.register();
    });
    afterAll(async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
    });

    it('adds the active span ids inside a span and nothing outside, through pino', () => {
      const lines: Record<string, unknown>[] = [];
      const logger = pino(
        { mixin: traceLogMixin },
        { write: (l: string) => lines.push(JSON.parse(l) as Record<string, unknown>) },
      );
      let ids: { traceId: string; spanId: string } | undefined;
      trace.getTracer('t').startActiveSpan('order.process', (span) => {
        ids = span.spanContext();
        logger.info('inside');
        logger.child({ orderId: 'o-1' }).info('inside child');
        span.end();
      });
      logger.info('outside');

      expect(lines[0]).toMatchObject({
        msg: 'inside',
        trace_id: ids?.traceId,
        span_id: ids?.spanId,
      });
      expect(lines[1]).toMatchObject({
        msg: 'inside child',
        trace_id: ids?.traceId,
        orderId: 'o-1',
      });
      expect(lines[2]?.msg).toBe('outside');
      expect(lines[2]).not.toHaveProperty('trace_id');
      expect(lines[2]).not.toHaveProperty('span_id');
    });
  });
});
