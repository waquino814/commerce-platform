export type FlushResult = 'flushed' | 'failed' | 'timed_out' | 'skipped';

export const FLUSH_CAP_MS = 300;
/** Kept clear of the hard deadline so exit always happens before it. */
export const FLUSH_DEADLINE_MARGIN_MS = 100;
export const FLUSH_MIN_BUDGET_MS = 50;

/**
 * Best-effort telemetry flush that can never extend shutdown past its budget:
 * `budget = min(capMs, deadlineAt - now() - 100)`, skipped entirely when under 50 ms.
 * Never throws. A late rejection from `flush` is caught, so it can never become an unhandled
 * rejection (which on Node 24 would crash the process and change its exit code). The underlying
 * export may stay pending after the timeout; the caller exits right after and abandons it.
 */
export async function flushWithinBudget(options: {
  flush: () => Promise<unknown>;
  deadlineAt: number;
  capMs?: number;
  now?: () => number;
}): Promise<{ result: FlushResult; budgetMs: number }> {
  const now = options.now ?? Date.now;
  const budgetMs = Math.min(
    options.capMs ?? FLUSH_CAP_MS,
    options.deadlineAt - now() - FLUSH_DEADLINE_MARGIN_MS,
  );
  if (budgetMs < FLUSH_MIN_BUDGET_MS) return { result: 'skipped', budgetMs };

  let flushing: Promise<unknown>;
  try {
    flushing = options.flush();
  } catch {
    return { result: 'failed', budgetMs };
  }
  flushing.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<FlushResult>((resolve) => {
    timer = setTimeout(() => {
      resolve('timed_out');
    }, budgetMs);
  });
  try {
    const result = await Promise.race([
      flushing.then(
        (): FlushResult => 'flushed',
        (): FlushResult => 'failed',
      ),
      timeout,
    ]);
    return { result, budgetMs };
  } finally {
    clearTimeout(timer);
  }
}
