import { ConfigError, parseEnv } from '@commerce/db/config';
import { z } from 'zod';

/** `METRICS_SAMPLE_INTERVAL_MS` when unset; also the disabled handle's value. */
export const DEFAULT_METRICS_SAMPLE_INTERVAL_MS = 5000;

const ms = (min: number) => z.coerce.number().int().min(min).max(600_000);
/** Treats an empty variable as unset, so `OTEL_EXPORTER_OTLP_ENDPOINT=` disables telemetry. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const schema = z.object({
  OTEL_EXPORTER_OTLP_ENDPOINT: optional(
    z.url({ protocol: /^https?$/, error: 'must be an http:// or https:// URL' }),
  ),
  OTEL_SDK_DISABLED: z.enum(['true', 'false']).default('false'),
  OTEL_SERVICE_NAME: optional(z.string().trim().min(1)),
  OTEL_SERVICE_INSTANCE_ID: optional(z.string().trim().min(1)),
  OTEL_EXPORTER_OTLP_TIMEOUT: ms(500).default(3000),
  OTEL_BSP_SCHEDULE_DELAY: ms(100).default(1000),
  OTEL_METRIC_EXPORT_INTERVAL: ms(1000).default(5000),
  OTEL_METRIC_EXPORT_TIMEOUT: ms(500).default(3000),
  METRICS_SAMPLE_INTERVAL_MS: ms(1000).default(DEFAULT_METRICS_SAMPLE_INTERVAL_MS),
});

export interface TelemetryConfig {
  /** True only when an endpoint is set and OTEL_SDK_DISABLED is not "true". */
  enabled: boolean;
  /** Collector base URL without a trailing slash, or null when unset. */
  endpoint: string | null;
  serviceName: string;
  serviceInstanceId: string;
  /** Resource `service.version`, from the app's package.json. */
  serviceVersion: string;
  exporterTimeoutMs: number;
  spanScheduleDelayMs: number;
  metricExportIntervalMs: number;
  metricExportTimeoutMs: number;
  metricsSampleIntervalMs: number;
}

/**
 * Reads and validates telemetry configuration. Throws ConfigError naming every invalid variable,
 * before any exporter or reader is constructed (the OTLP exporter throws on a malformed URL, and
 * the metric reader throws when the export interval is shorter than the export timeout).
 */
export function loadTelemetryConfig(
  env: NodeJS.ProcessEnv,
  defaults: { serviceName: string; serviceInstanceId: string; serviceVersion: string },
): TelemetryConfig {
  const p = parseEnv(schema, env);
  if (p.OTEL_METRIC_EXPORT_INTERVAL < p.OTEL_METRIC_EXPORT_TIMEOUT) {
    throw new ConfigError(
      'invalid configuration: OTEL_METRIC_EXPORT_INTERVAL: must be greater than or equal to ' +
        `OTEL_METRIC_EXPORT_TIMEOUT (${p.OTEL_METRIC_EXPORT_INTERVAL} < ${p.OTEL_METRIC_EXPORT_TIMEOUT})`,
    );
  }
  const endpoint = p.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '') ?? null;
  return {
    enabled: endpoint !== null && p.OTEL_SDK_DISABLED === 'false',
    endpoint,
    serviceName: p.OTEL_SERVICE_NAME ?? defaults.serviceName,
    serviceInstanceId: p.OTEL_SERVICE_INSTANCE_ID ?? defaults.serviceInstanceId,
    serviceVersion: defaults.serviceVersion,
    exporterTimeoutMs: p.OTEL_EXPORTER_OTLP_TIMEOUT,
    spanScheduleDelayMs: p.OTEL_BSP_SCHEDULE_DELAY,
    metricExportIntervalMs: p.OTEL_METRIC_EXPORT_INTERVAL,
    metricExportTimeoutMs: p.OTEL_METRIC_EXPORT_TIMEOUT,
    metricsSampleIntervalMs: p.METRICS_SAMPLE_INTERVAL_MS,
  };
}
