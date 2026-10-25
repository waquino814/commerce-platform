import { z } from 'zod';
import { hex, identifier, PROMETHEUS_LABEL, PROMETHEUS_NAME, timestamp } from './formats.js';

/**
 * Incident bundle schema version 1: one record per line of each JSONL file
 * (docs/prompts/m5-design.md, "Bundle documents"). Objects are loose.
 */

/**
 * A sample value exactly as Prometheus returns it. Prometheus's HTTP API sends values as strings,
 * and `NaN`, `+Inf` and `-Inf` cannot be JSON numbers.
 */
export const SAMPLE_VALUE = /^(?:NaN|[+-]Inf|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;

/** `metrics.jsonl`: one Prometheus series. */
export const metricsRecordSchema = z.looseObject({
  name: z.string().regex(PROMETHEUS_NAME),
  /** Every label except `__name__`. */
  labels: z.record(z.string().regex(PROMETHEUS_LABEL), z.string()),
  /** `[unixSeconds, value]`, in ascending time order. */
  samples: z.array(z.tuple([z.number(), z.string().regex(SAMPLE_VALUE)])),
});

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'] as const;

/** `logs.jsonl`: one normalized log record. */
export const logsRecordSchema = z.looseObject({
  service: identifier,
  time: timestamp,
  level: z.enum(LOG_LEVELS),
  message: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  trace_id: hex(32).optional(),
  span_id: hex(16).optional(),
});

const span = z.looseObject({
  traceId: hex(32),
  spanId: hex(16),
  name: z.string(),
  startTimeUnixNano: z.string().regex(/^\d+$/),
});

/**
 * `traces.jsonl`: one trace as an OTLP JSON `TracesData` object. The check is structural, not
 * semantic: parent links, span kinds and attribute value types are not validated. That every span
 * on a line has the same `traceId` is checked by `traceIdsOf` and the validator.
 */
export const traceRecordSchema = z.looseObject({
  resourceSpans: z
    .array(z.looseObject({ scopeSpans: z.array(z.looseObject({ spans: z.array(span) })) }))
    .min(1),
});

export type MetricsRecord = z.infer<typeof metricsRecordSchema>;
export type LogsRecord = z.infer<typeof logsRecordSchema>;
export type TraceRecord = z.infer<typeof traceRecordSchema>;

/** The distinct trace IDs of a trace record's spans; a valid line has exactly one. */
export function traceIdsOf(record: TraceRecord): string[] {
  const ids = new Set<string>();
  for (const rs of record.resourceSpans) {
    for (const ss of rs.scopeSpans) for (const s of ss.spans) ids.add(s.traceId);
  }
  return [...ids];
}
