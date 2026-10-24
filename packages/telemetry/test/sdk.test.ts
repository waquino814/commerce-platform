import { context, diag, metrics, trace } from '@opentelemetry/api';
import { ExportResultCode, globalErrorHandler } from '@opentelemetry/core';
import {
  AggregationTemporality,
  InstrumentType,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_METRICS_SAMPLE_INTERVAL_MS, loadTelemetryConfig } from '../src/config.js';
import type { DiagLine } from '../src/diag.js';
import { DISABLED_TELEMETRY, getActiveTelemetry, setActiveTelemetry } from '../src/handle.js';
import { createApiMetrics, METER_NAME } from '../src/metrics.js';
import { packageVersion } from '../src/register.js';
import { selectMetricTemporality, startTelemetry, withMetricTemporality } from '../src/sdk.js';
import { CollectingReader } from './metric-support.js';

const defaults = { serviceName: 'orders-api', serviceInstanceId: 'api-1', serviceVersion: '0.0.0' };

describe('startTelemetry', () => {
  afterEach(() => {
    metrics.disable();
  });
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
    expect(handle.metricsSampleIntervalMs).toBe(DEFAULT_METRICS_SAMPLE_INTERVAL_MS);
    expect(loadTelemetryConfig({}, defaults).metricsSampleIntervalMs).toBe(
      DEFAULT_METRICS_SAMPLE_INTERVAL_MS,
    );
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

  it('registers a global meter provider with the same resource, flushed and shut down with traces', async () => {
    const reader = new CollectingReader();
    const handle = startTelemetry({
      config: loadTelemetryConfig(
        { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9', METRICS_SAMPLE_INTERVAL_MS: '2000' },
        defaults,
      ),
      emitDiag: () => undefined,
      spanExporter: new InMemorySpanExporter(),
      metricReader: reader,
    });
    expect(handle.metricsSampleIntervalMs).toBe(2000);

    // Taken after startTelemetry, as the apps do: the global meter now records.
    createApiMetrics().recordRequest({
      method: 'GET',
      route: '/products',
      statusCode: 200,
      durationS: 0.01,
    });
    const { resourceMetrics } = await reader.collect();
    expect(resourceMetrics.resource.attributes).toMatchObject({
      'service.name': 'orders-api',
      'service.version': '0.0.0',
      'service.instance.id': 'api-1',
      'deployment.environment.name': 'local',
    });
    expect(resourceMetrics.scopeMetrics.map((s) => s.scope.name)).toEqual([METER_NAME]);
    expect(resourceMetrics.scopeMetrics[0]?.metrics.map((m) => m.descriptor.name)).toEqual([
      'http.server.request.duration',
    ]);

    await expect(handle.forceFlush()).resolves.toBeUndefined();
    await handle.shutdown();
    // The reader is shut down with the meter provider.
    await expect(reader.collect()).rejects.toThrow();
  });
});

describe('packageVersion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-version-'));
  const file = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return pathToFileURL(path);
  };

  it('reads the version, and falls back to "unknown" without one', () => {
    expect(packageVersion(file('ok.json', '{"version":"1.4.0"}'))).toBe('1.4.0');
    expect(packageVersion(file('none.json', '{"name":"x"}'))).toBe('unknown');
    expect(packageVersion(file('empty.json', '{"version":""}'))).toBe('unknown');
    expect(packageVersion(file('bad.json', 'not json'))).toBe('unknown');
    expect(packageVersion(pathToFileURL(join(dir, 'missing.json')))).toBe('unknown');
  });

  it("reads the apps' real package.json files", () => {
    for (const app of ['orders-api', 'worker']) {
      const url = new URL(`../../../apps/${app}/package.json`, import.meta.url);
      expect(packageVersion(url)).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

describe('metric temporality', () => {
  it('is cumulative for counters, histograms and up-down counters, and delta for observable gauges', () => {
    const cumulative = [
      InstrumentType.COUNTER,
      InstrumentType.HISTOGRAM,
      InstrumentType.OBSERVABLE_UP_DOWN_COUNTER,
      InstrumentType.UP_DOWN_COUNTER,
    ];
    for (const type of cumulative) {
      expect(selectMetricTemporality(type)).toBe(AggregationTemporality.CUMULATIVE);
    }
    expect(selectMetricTemporality(InstrumentType.OBSERVABLE_GAUGE)).toBe(
      AggregationTemporality.DELTA,
    );
  });

  it('the wrapped exporter delegates export, flush and shutdown, and selects that temporality', async () => {
    const calls: string[] = [];
    const inner: PushMetricExporter = {
      export: (_data, done) => {
        calls.push('export');
        done({ code: ExportResultCode.SUCCESS });
      },
      forceFlush: () => {
        calls.push('flush');
        return Promise.resolve();
      },
      shutdown: () => {
        calls.push('shutdown');
        return Promise.resolve();
      },
      selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    };
    const wrapped = withMetricTemporality(inner);
    let result: ExportResultCode | undefined;
    wrapped.export({} as ResourceMetrics, (r) => {
      result = r.code;
    });
    await wrapped.forceFlush();
    await wrapped.shutdown();
    expect(calls).toEqual(['export', 'flush', 'shutdown']);
    expect(result).toBe(ExportResultCode.SUCCESS);
    expect(wrapped.selectAggregationTemporality?.(InstrumentType.OBSERVABLE_GAUGE)).toBe(
      AggregationTemporality.DELTA,
    );
  });
});
