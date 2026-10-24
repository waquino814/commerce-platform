import { ConfigError } from '@commerce/db';
import { describe, expect, it } from 'vitest';
import { loadTelemetryConfig } from '../src/config.js';

const defaults = { serviceName: 'worker', serviceInstanceId: 'host-1' };

describe('loadTelemetryConfig (criteria 1 and 2)', () => {
  it('is disabled without an endpoint, with documented defaults', () => {
    expect(loadTelemetryConfig({}, defaults)).toEqual({
      enabled: false,
      endpoint: null,
      serviceName: 'worker',
      serviceInstanceId: 'host-1',
      exporterTimeoutMs: 3000,
      spanScheduleDelayMs: 1000,
      metricExportIntervalMs: 5000,
      metricExportTimeoutMs: 3000,
      metricsSampleIntervalMs: 5000,
    });
    expect(loadTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }, defaults).enabled).toBe(false);
  });

  it('is enabled with an endpoint, trimming a trailing slash, unless OTEL_SDK_DISABLED is true', () => {
    const on = loadTelemetryConfig(
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/' },
      defaults,
    );
    expect(on).toMatchObject({ enabled: true, endpoint: 'http://otel-collector:4318' });
    expect(
      loadTelemetryConfig(
        { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SDK_DISABLED: 'true' },
        defaults,
      ).enabled,
    ).toBe(false);
  });

  it('accepts overrides for service name and instance id', () => {
    expect(
      loadTelemetryConfig({ OTEL_SERVICE_NAME: 'svc', OTEL_SERVICE_INSTANCE_ID: 'i-9' }, defaults),
    ).toMatchObject({ serviceName: 'svc', serviceInstanceId: 'i-9' });
  });

  it.each([
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' }, /OTEL_EXPORTER_OTLP_ENDPOINT/],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc://c:4317' }, /OTEL_EXPORTER_OTLP_ENDPOINT/],
    [{ OTEL_SDK_DISABLED: 'yes' }, /OTEL_SDK_DISABLED/],
    [{ OTEL_METRIC_EXPORT_INTERVAL: '999' }, /OTEL_METRIC_EXPORT_INTERVAL/],
    [{ OTEL_METRIC_EXPORT_TIMEOUT: '499' }, /OTEL_METRIC_EXPORT_TIMEOUT/],
    [{ OTEL_BSP_SCHEDULE_DELAY: '99' }, /OTEL_BSP_SCHEDULE_DELAY/],
    [{ OTEL_EXPORTER_OTLP_TIMEOUT: 'abc' }, /OTEL_EXPORTER_OTLP_TIMEOUT/],
    [{ METRICS_SAMPLE_INTERVAL_MS: '10' }, /METRICS_SAMPLE_INTERVAL_MS/],
  ])('rejects %j, naming the variable', (env, message) => {
    expect(() => loadTelemetryConfig(env, defaults)).toThrow(ConfigError);
    expect(() => loadTelemetryConfig(env, defaults)).toThrow(message);
  });

  it('rejects an export interval below the export timeout, naming both variables', () => {
    const env = { OTEL_METRIC_EXPORT_INTERVAL: '1000', OTEL_METRIC_EXPORT_TIMEOUT: '3000' };
    expect(() => loadTelemetryConfig(env, defaults)).toThrow(ConfigError);
    expect(() => loadTelemetryConfig(env, defaults)).toThrow(
      /OTEL_METRIC_EXPORT_INTERVAL.*OTEL_METRIC_EXPORT_TIMEOUT/,
    );
    expect(
      loadTelemetryConfig(
        { OTEL_METRIC_EXPORT_INTERVAL: '3000', OTEL_METRIC_EXPORT_TIMEOUT: '3000' },
        defaults,
      ).metricExportIntervalMs,
    ).toBe(3000);
  });
});
