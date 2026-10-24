export { loadTelemetryConfig, type TelemetryConfig } from './config.js';
export {
  createRateLimitedDiagLogger,
  messageKind,
  type DiagLine,
  type RateLimitedDiagLogger,
} from './diag.js';
export { traceLogMixin } from './log-mixin.js';
export { isProbePath, nameServerSpan, PROBE_PATHS } from './http.js';
export { flushWithinBudget, FLUSH_CAP_MS, type FlushResult } from './flush.js';
export {
  DISABLED_TELEMETRY,
  getActiveTelemetry,
  setActiveTelemetry,
  type TelemetryHandle,
} from './handle.js';
export { completeShutdown } from './shutdown.js';
export { startTelemetry, BATCH_MAX_QUEUE_SIZE, type StartTelemetryOptions } from './sdk.js';
export { registerTelemetry } from './register.js';
export {
  annotateActiveSpan,
  creationLink,
  currentTraceparent,
  markSpanError,
  parseTraceparent,
  recordSweep,
  withSpan,
  type Attributes,
  type Span,
  type SweepItem,
  type WithSpanOptions,
} from './correlation.js';
