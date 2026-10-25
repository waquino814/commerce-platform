export {
  captureTraces,
  DEFAULTS as TRACE_CAPTURE_DEFAULTS,
  type TracesCapture,
  type TracesOptions,
} from './capture/jaeger.js';
export { captureLogs, normalizeLogs, type LogsCapture } from './capture/logs.js';
export {
  CATALOG,
  captureMetrics,
  PROMETHEUS_SERIES,
  prometheusNames,
  type MetricsCapture,
} from './capture/prometheus.js';
export type { CaptureWindow, CommandResult, HttpFetch, RunCommand } from './capture/deps.js';
