import type { OrderStatusCounts } from '@commerce/telemetry';

/** A sample older than this many intervals is treated as missing. */
export const STALE_AFTER_INTERVALS = 3;

export interface SamplerTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: SamplerTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  },
};

export interface SamplerDeps {
  /** Runs the count query on the dedicated metrics pool, never the worker or simulator pool. */
  query: () => Promise<OrderStatusCounts>;
  intervalMs: number;
  logger: { debug(obj: object, msg: string): void };
  now?: () => number;
  timers?: SamplerTimers;
}

export interface OrderStatusSampler {
  /** Samples once now, then every interval. */
  start(): void;
  /** Stops the timer and any further samples. A sample already running is left to finish. */
  stop(): void;
  /** Runs one sample unless one is already running. Never rejects. */
  sample(): Promise<void>;
  /** The latest sample, or null when there is none or it is older than three intervals. */
  read(): OrderStatusCounts | null;
}

/**
 * Order counts for the `commerce.orders` gauge (docs/prompts/m3-design.md, "Order-status sampler
 * and the metrics pool"). The gauge callback reads only the cache. A failed sample, whether a
 * timeout, a database outage or a pool error, is logged at debug level and skipped: it is never
 * thrown, retried in a loop, or allowed to touch order processing.
 */
export function createOrderStatusSampler(deps: SamplerDeps): OrderStatusSampler {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? realTimers;
  let cache: { counts: OrderStatusCounts; at: number } | null = null;
  let running = false;
  let stopped = false;
  let handle: unknown = null;

  async function sample(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const counts = await deps.query();
      cache = { counts, at: now() };
    } catch (err) {
      deps.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'order_status_sample_failed',
      );
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (handle !== null || stopped) return;
      handle = timers.setInterval(() => {
        void sample();
      }, deps.intervalMs);
      void sample();
    },
    stop() {
      stopped = true;
      if (handle !== null) timers.clearInterval(handle);
      handle = null;
    },
    sample,
    read() {
      if (!cache) return null;
      return now() - cache.at > STALE_AFTER_INTERVALS * deps.intervalMs ? null : cache.counts;
    },
  };
}
