import { diag, DiagLogLevel } from '@opentelemetry/api';
import { setGlobalErrorHandler } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
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
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Starts tracing when enabled, and returns a no-op handle otherwise. Order matters:
 * the rate-limited diag logger and global error handler are installed before any exporter,
 * processor or instrumentation is constructed, so every component reports through them.
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

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': config.serviceName,
      'service.instance.id': config.serviceInstanceId,
      'deployment.environment.name': 'local',
    }),
    spanProcessors: [processor],
  });
  provider.register();

  const unregister = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => isProbePath(request.url),
      }),
      new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false }),
    ],
  });

  return {
    enabled: true,
    forceFlush: () => provider.forceFlush(),
    shutdown: async () => {
      unregister();
      await provider.shutdown();
    },
  };
}
