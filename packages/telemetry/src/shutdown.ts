import { flushWithinBudget, type FlushResult } from './flush.js';
import type { TelemetryHandle } from './handle.js';

/**
 * Final shutdown step after an app's own shutdown protocol has produced its exit code:
 * cleanup, then a bounded telemetry flush, then exit. Telemetry never changes the exit code; a
 * failed cleanup still exits 1, exactly as before telemetry existed.
 */
export async function completeShutdown(options: {
  exitCode: number;
  cleanup: () => Promise<void>;
  telemetry: TelemetryHandle;
  deadlineAt: number;
  exit: (code: number) => void;
  now?: () => number;
  onCleanupError?: (err: unknown) => void;
  onFlush?: (result: FlushResult, budgetMs: number) => void;
}): Promise<void> {
  let exitCode = options.exitCode;
  try {
    await options.cleanup();
  } catch (err) {
    options.onCleanupError?.(err);
    exitCode = 1;
  }
  const flush = await flushWithinBudget({
    flush: () => options.telemetry.forceFlush(),
    deadlineAt: options.deadlineAt,
    ...(options.now ? { now: options.now } : {}),
  });
  options.onFlush?.(flush.result, flush.budgetMs);
  options.telemetry.shutdown().catch(() => undefined);
  options.exit(exitCode);
}
