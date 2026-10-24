import { diag, DiagLogLevel, metrics } from '@opentelemetry/api';
import { setGlobalErrorHandler } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-node';
import type { TelemetryConfig } from './config.js';
import { createRateLimitedDiagLogger, type DiagLine } from './diag.js';
import { DISABLED_TELEMETRY, type TelemetryHandle } from './handle.js';
import { isProbePath } from './http.js';
import { NOOP_METER_PROVIDER } from './metrics.js';

export const BATCH_MAX_QUEUE_SIZE = 2048;

export interface StartTelemetryOptions {
  config: TelemetryConfig;
  /** Where rate-limited OpenTelemetry diagnostics go. */
  emitDiag: (line: DiagLine) => void;
  /**
   * Test seam: replaces the OTLP exporter and exports each span synchronously. Production
   * code never sets it.
   */
  spanExporter?: SpanExporter;
  /**
   * Test seam: replaces the periodic OTLP metric reader, so a test collects on demand. Production
   * code never sets it.
   */
  metricReader?: MetricReader;
}

/**
 * Cumulative for counters, histograms and up-down counters, as Prometheus expects. Delta for
 * observable gauges: a cumulative gauge keeps exporting its last value after the callback stops
 * observing it, so a stale order-status sample would go on reporting old counts. With delta, a
 * gauge reports only what its callback observed in this collection. OTLP gauges carry no
 * temporality, so the collector sees an ordinary gauge either way.
 */
export function selectMetricTemporality(type: InstrumentType): AggregationTemporality {
  return type === InstrumentType.OBSERVABLE_GAUGE
    ? AggregationTemporality.DELTA
    : AggregationTemporality.CUMULATIVE;
}

/** Applies selectMetricTemporality to an exporter, whose options accept only one preference. */
export function withMetricTemporality(exporter: PushMetricExporter): PushMetricExporter {
  return {
    export: (data, done) => {
      exporter.export(data, done);
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
    selectAggregationTemporality: selectMetricTemporality,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Starts tracing and metrics when enabled, and returns a no-op handle otherwise. Order matters:
 * the rate-limited diag logger and global error handler are installed before any exporter,
 * processor, reader or instrumentation is constructed, so every component reports through them.
 */
export function startTelemetry(options: StartTelemetryOptions): TelemetryHandle {
  const { config } = options;
  if (!config.enabled || config.endpoint === null) return DISABLED_TELEMETRY;

  const diagLogger = createRateLimitedDiagLogger({ emit: options.emitDiag });
  diag.setLogger(diagLogger, { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true });
  setGlobalErrorHandler((err) => {
    diagLogger.error(`OpenTelemetry error: ${errorMessage(err)}`);
  });

  const processor = options.spanExporter
    ? new SimpleSpanProcessor(options.spanExporter)
    : new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${config.endpoint}/v1/traces`,
          timeoutMillis: config.exporterTimeoutMs,
        }),
        {
          scheduledDelayMillis: config.spanScheduleDelayMs,
          maxQueueSize: BATCH_MAX_QUEUE_SIZE,
          exportTimeoutMillis: config.exporterTimeoutMs,
        },
      );

  const resource = resourceFromAttributes({
    'service.name': config.serviceName,
    'service.version': config.serviceVersion,
    'service.instance.id': config.serviceInstanceId,
    'deployment.environment.name': 'local',
  });
  const provider = new NodeTracerProvider({ resource, spanProcessors: [processor] });
  provider.register();

  // Metrics export on the reader's own timer; nothing in a request or pass awaits it.
  const reader =
    options.metricReader ??
    new PeriodicExportingMetricReader({
      exporter: withMetricTemporality(
        new OTLPMetricExporter({
          url: `${config.endpoint}/v1/metrics`,
          timeoutMillis: config.exporterTimeoutMs,
          // Explicit, so OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE is never read.
          temporalityPreference: AggregationTemporality.CUMULATIVE,
        }),
      ),
      exportIntervalMillis: config.metricExportIntervalMs,
      exportTimeoutMillis: config.metricExportTimeoutMs,
    });
  const meterProvider = new MeterProvider({ resource, readers: [reader] });
  metrics.setGlobalMeterProvider(meterProvider);

  const unregister = registerInstrumentations({
    tracerProvider: provider,
    // The instrumentations keep their traces but record no metrics; only the catalog does.
    meterProvider: NOOP_METER_PROVIDER,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => isProbePath(request.url),
      }),
      new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false }),
    ],
  });

  return {
    enabled: true,
    metricsSampleIntervalMs: config.metricsSampleIntervalMs,
    forceFlush: async () => {
      await Promise.all([provider.forceFlush(), meterProvider.forceFlush()]);
    },
    shutdown: async () => {
      unregister();
      await Promise.all([provider.shutdown(), meterProvider.shutdown()]);
    },
  };
}
