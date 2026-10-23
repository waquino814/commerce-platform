import type { FastifyBaseLogger } from 'fastify';

export interface WorkerLoopDeps<T> {
  /** Claims up to `limit` orders. Only the loop claims. */
  claim: (limit: number) => Promise<T[]>;
  /** Returns expired claims. Runs on every poll, even with no free slot. */
  recover: () => Promise<unknown>;
  /** Processes one order. Invoked synchronously for every claimed order. Must not reject. */
  process: (item: T) => Promise<unknown>;
  concurrency: number;
  claimBatchSize: number;
  pollIntervalMs: number;
  logger: FastifyBaseLogger;
  /** Test seam: called synchronously with each claim's result, before dispatch. */
  onClaim?: (items: T[]) => void;
}

/**
 * Slot-based claiming. Invariant: every claimed order starts processing in the same
 * event-loop turn in which the claim returns, so no claimed order waits in memory.
 *
 * Before each claim the loop computes `free = concurrency - inFlight`. With no free slot it sends
 * no claim. Otherwise it claims `min(free, claimBatchSize)`. A finished order frees its slot and
 * wakes the loop at once, without waiting for the poll interval.
 *
 * Resolves once `signal` aborts and any claim already in flight has been dispatched. In-flight
 * passes keep running; the shutdown coordinator decides what happens to them.
 */
export async function runWorkerLoop<T>(
  deps: WorkerLoopDeps<T>,
  signal: AbortSignal,
): Promise<void> {
  const { logger, concurrency, claimBatchSize, pollIntervalMs } = deps;
  let inFlight = 0;
  let wake: (() => void) | null = null;
  // Read through a function: the flag changes across awaits, which narrowing cannot see.
  const stopped = (): boolean => signal.aborted;

  logger.info({ concurrency, claimBatchSize, pollIntervalMs }, 'worker loop started');

  while (!stopped()) {
    try {
      await deps.recover();
    } catch (err) {
      logger.error({ err }, 'claim recovery failed');
    }
    if (stopped()) break;

    const free = concurrency - inFlight;
    let claimedFullBatch = false;
    if (free > 0) {
      const limit = Math.min(free, claimBatchSize);
      let claimed: T[] = [];
      try {
        claimed = await deps.claim(limit);
      } catch (err) {
        logger.error({ err }, 'claiming orders failed');
      }
      // Dispatch synchronously, even if shutdown began during the claim: these rows were
      // claimed against free slots.
      deps.onClaim?.(claimed);
      for (const item of claimed) {
        inFlight += 1;
        void deps.process(item).finally(() => {
          inFlight -= 1;
          wake?.();
        });
      }
      claimedFullBatch = claimed.length === limit && inFlight < concurrency;
    }

    if (stopped()) break;
    if (claimedFullBatch) continue;

    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, pollIntervalMs);
      signal.addEventListener('abort', done, { once: true });
      wake = done;
    });
  }

  logger.info('worker loop stopped');
}
