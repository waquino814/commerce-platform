import { FAULT_STREAMS, stream } from './random.js';
import { ORDER_READ_FAILURE_PERCENT, PAYMENT_HANG_PERCENT, poisonSku } from './scenarios.js';
import type { Effect } from './controller.js';

/**
 * The injection hooks (docs/prompts/m5-design.md, "Hooks"). Each one is a pass-through while its
 * scenario is inactive, and the apps do not create them at all when faults are disabled.
 */

/** `bad-deploy-order-reads`: decides which order reads fail, from a seeded stream. */
export function createOrderReadFault(): { effect: Effect; shouldFail(): boolean } {
  let draw: ((n: number) => number) | null = null;
  return {
    effect: {
      activate(seed) {
        draw = stream(seed, FAULT_STREAMS.orderReadFailures);
      },
      deactivate() {
        draw = null;
      },
    },
    shouldFail: () => draw !== null && draw(100) < ORDER_READ_FAILURE_PERCENT,
  };
}

export interface PaymentProviderLike<Req, Res> {
  charge(request: Req): Promise<Res>;
  lookupOrVoid(orderId: string): Promise<Res>;
}

/**
 * `payment-timeouts` and `provider-outage`. The errors come from the worker, so this package needs
 * no worker types: `unavailable` is what a down provider returns, and `reset` settles calls that
 * were left hanging once the scenario stops.
 */
export function createPaymentFaults(errors: { unavailable: () => Error; reset: () => Error }): {
  timeouts: Effect;
  outage: Effect;
  wrap<Req, Res>(provider: PaymentProviderLike<Req, Res>): PaymentProviderLike<Req, Res>;
  pendingCount(): number;
} {
  let hangDraw: ((n: number) => number) | null = null;
  let outage = false;
  const pending = new Set<(err: Error) => void>();

  const hang = <Res>(): Promise<Res> => {
    let rejectFn: ((err: Error) => void) | undefined;
    const promise = new Promise<Res>((_, reject) => {
      rejectFn = reject;
    });
    // Handled before it is returned: a rejection after the caller gave up is never unhandled.
    promise.catch(() => undefined);
    if (rejectFn) pending.add(rejectFn);
    return promise;
  };

  return {
    timeouts: {
      activate(seed) {
        hangDraw = stream(seed, FAULT_STREAMS.paymentHangs);
      },
      deactivate() {
        hangDraw = null;
        const rejects = [...pending];
        pending.clear();
        for (const reject of rejects) reject(errors.reset());
      },
    },
    outage: {
      activate() {
        outage = true;
      },
      deactivate() {
        outage = false;
      },
    },
    wrap: (provider) => ({
      charge: (request) => {
        if (outage) return Promise.reject(errors.unavailable());
        if (hangDraw !== null && hangDraw(100) < PAYMENT_HANG_PERCENT) return hang();
        return provider.charge(request);
      },
      lookupOrVoid: (orderId) =>
        outage ? Promise.reject(errors.unavailable()) : provider.lookupOrVoid(orderId),
    }),
    pendingCount: () => pending.size,
  };
}

export interface PoolLike {
  connect(): Promise<{ release(): void }>;
  readonly options: { max?: number | undefined };
}

/**
 * `api-pool-exhaustion`: checks out every connection of the pool and holds it, as a leak would.
 * It keeps asking until it holds them all, since its own requests share the connect timeout, and
 * releases everything on stop, expiry or shutdown, so `pool.end()` never waits on it.
 */
export function createPoolLeak(
  pool: PoolLike,
  options: { retryDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): { effect: Effect; heldCount(): number; settled(): Promise<void> } {
  const max = pool.options.max ?? 10;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  let generation = 0;
  let held: { release(): void }[] = [];
  let loop: Promise<void> = Promise.resolve();

  const acquire = async (mine: number): Promise<void> => {
    while (generation === mine && held.length < max) {
      try {
        const client = await pool.connect();
        if (generation === mine) held.push(client);
        else client.release();
      } catch {
        if (generation !== mine) return;
        await sleep(retryDelayMs);
      }
    }
  };

  return {
    effect: {
      activate() {
        generation += 1;
        loop = acquire(generation);
      },
      deactivate() {
        generation += 1;
        const clients = held;
        held = [];
        for (const client of clients) client.release();
      },
    },
    heldCount: () => held.length,
    settled: () => loop,
  };
}

/**
 * `poison-order`: a processor `beforeStep` hook. While active, any pass of an order containing the
 * poison SKU hangs until the scenario stops, then fails with an error. Inactive, it returns
 * nothing at once, without a query.
 */
export function createPoisonFault(deps: {
  skusOf: (orderId: string) => Promise<readonly string[]>;
}): {
  effect: Effect;
  beforeStep(step: string, order: { readonly id: string }): Promise<void> | undefined;
  hungCount(): number;
} {
  let sku: string | null = null;
  const hung = new Set<(err: Error) => void>();
  return {
    effect: {
      activate(seed) {
        sku = poisonSku(seed);
      },
      deactivate() {
        sku = null;
        const rejects = [...hung];
        hung.clear();
        for (const reject of rejects) reject(new Error('processing aborted after a stall'));
      },
    },
    beforeStep(_step, order) {
      const target = sku;
      if (target === null) return undefined;
      return deps.skusOf(order.id).then((skus) => {
        if (sku !== target || !skus.includes(target)) return undefined;
        return new Promise<void>((_, reject) => {
          hung.add(reject);
        });
      });
    },
    hungCount: () => hung.size,
  };
}
