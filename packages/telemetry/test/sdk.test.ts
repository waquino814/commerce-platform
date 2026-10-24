import { context, diag, trace } from '@opentelemetry/api';
import { globalErrorHandler } from '@opentelemetry/core';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { afterAll, describe, expect, it } from 'vitest';
import { loadTelemetryConfig } from '../src/config.js';
import type { DiagLine } from '../src/diag.js';
import { DISABLED_TELEMETRY, getActiveTelemetry, setActiveTelemetry } from '../src/handle.js';
import { startTelemetry } from '../src/sdk.js';

const defaults = { serviceName: 'orders-api', serviceInstanceId: 'api-1' };

describe('startTelemetry', () => {
  afterAll(() => {
    trace.disable();
    context.disable();
    diag.disable();
  });

  it('returns the disabled handle and registers nothing without an endpoint (criterion 1)', async () => {
    const lines: DiagLine[] = [];
    const handle = startTelemetry({
      config: loadTelemetryConfig({}, defaults),
      emitDiag: (l) => lines.push(l),
    });
    expect(handle).toBe(DISABLED_TELEMETRY);
    expect(handle.enabled).toBe(false);
    await expect(handle.forceFlush()).resolves.toBeUndefined();
    const span = trace.getTracer('t').startSpan('x');
    expect(span.isRecording()).toBe(false);
    span.end();
    diag.error('not routed');
    expect(lines).toEqual([]);
    expect(getActiveTelemetry()).toBe(DISABLED_TELEMETRY);
  });

  it('records spans with resource attributes and routes diag and global errors through the limiter', async () => {
    const exporter = new InMemorySpanExporter();
    const lines: DiagLine[] = [];
    const handle = startTelemetry({
      config: loadTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' }, defaults),
      emitDiag: (l) => lines.push(l),
      spanExporter: exporter,
    });
    setActiveTelemetry(handle);
    expect(getActiveTelemetry().enabled).toBe(true);

    trace.getTracer('t').startActiveSpan('order.create', (span) => {
      span.end();
    });
    await handle.forceFlush();
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('order.create');
    expect(span?.resource.attributes).toMatchObject({
      'service.name': 'orders-api',
      'service.instance.id': 'api-1',
      'deployment.environment.name': 'local',
    });

    diag.error('Error: connect ECONNREFUSED 127.0.0.1:9');
    diag
      .createComponentLogger({ namespace: '@opentelemetry/instrumentation-pg' })
      .warn('hook problem');
    globalErrorHandler(new Error('export failed'));
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      ['error', 'Error: connect ECONNREFUSED 127.0.0.1:9'],
      ['warn', '@opentelemetry/instrumentation-pg hook problem'],
      ['error', 'OpenTelemetry error: Error: export failed'],
    ]);

    await handle.shutdown();
    setActiveTelemetry(DISABLED_TELEMETRY);
  });
});
