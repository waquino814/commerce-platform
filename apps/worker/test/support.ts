import { claimDueOrders, type ClaimedOrder, type Pool } from '@commerce/db';
import { pino, type Logger } from 'pino';
import type { Limits } from '../src/lifecycle.js';
import { PassRegistry } from '../src/pass-context.js';
import {
  PaymentTimeoutError,
  ProviderError,
  type ChargeRequest,
  type PaymentProvider,
  type ProviderResult,
} from '../src/payment/provider.js';
import { createPaymentSimulator } from '../src/payment/simulator.js';
import {
  createProcessor,
  type OrderStore,
  type PassOutcome,
  type Processor,
  type ProcessorHooks,
} from '../src/processor.js';
import * as db from '@commerce/db';

export const silentLogger = pino({ level: 'silent' });

/** Production defaults. Tests make orders due with SQL instead of waiting. */
export const DEFAULT_LIMITS: Limits = {
  maxClaims: 10,
  maxChargeAttempts: 3,
  maxReconciliationAttempts: 5,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 30_000,
  reconciliationBaseDelayMs: 5000,
  reconciliationMaxDelayMs: 60_000,
  paymentUnknownRecheckMs: 900_000,
};

export function limits(overrides: Partial<Limits> = {}): Limits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

/** A logger that keeps every line, so tests can assert on structured events. */
export function captureLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'debug' },
    {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines };
}

export class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (err: Error) => void;
  readonly promise = new Promise<T>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
}

/** Polls a condition until it holds. Synchronization only: never a timing assertion. */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const approved = (reference = 'ref-1', replayed = false): ProviderResult => ({
  outcome: 'approved',
  reference,
  replayed,
});

/**
 * A controllable provider. By default `charge` approves and `lookupOrVoid` fails. Set
 * `onCharge` / `onLookup`, or call `blockCharges()` to hold every charge until released.
 */
export class FakeProvider implements PaymentProvider {
  readonly charges: ChargeRequest[] = [];
  readonly lookups: string[] = [];
  readonly results: (ProviderResult | Error)[] = [];
  running = 0;
  maxRunning = 0;
  onCharge: (request: ChargeRequest) => Promise<ProviderResult> = (r) =>
    Promise.resolve(approved(`ref-${r.orderId.slice(0, 8)}`));
  onLookup: (orderId: string) => Promise<ProviderResult> = () =>
    Promise.reject(new ProviderError('lookup_unavailable'));
  private readonly blocked = new Map<string, Deferred<ProviderResult>>();

  blockCharges(): void {
    this.onCharge = (request) => {
      const gate = new Deferred<ProviderResult>();
      this.blocked.set(request.orderId, gate);
      return gate.promise;
    };
  }

  get blockedOrderIds(): string[] {
    return [...this.blocked.keys()];
  }

  release(orderId: string, result: ProviderResult | Error): void {
    const gate = this.blocked.get(orderId);
    if (!gate) throw new Error(`no blocked charge for ${orderId}`);
    this.blocked.delete(orderId);
    if (result instanceof Error) gate.reject(result);
    else gate.resolve(result);
  }

  async charge(request: ChargeRequest): Promise<ProviderResult> {
    this.charges.push(request);
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      const result = await this.onCharge(request);
      this.results.push(result);
      return result;
    } catch (err) {
      this.results.push(err as Error);
      throw err;
    } finally {
      this.running -= 1;
    }
  }

  lookupOrVoid(orderId: string): Promise<ProviderResult> {
    this.lookups.push(orderId);
    return this.onLookup(orderId);
  }
}

export const timeoutError = (): Error => new PaymentTimeoutError(5000);

/** The real simulator on its own pool, with call counting. */
export function realSimulator(pool: Pool, logger = silentLogger) {
  const simulator = createPaymentSimulator({ pool, logger, latencyMs: 0 });
  const calls = {
    charges: [] as ChargeRequest[],
    lookups: [] as string[],
    results: [] as ProviderResult[],
  };
  const provider: PaymentProvider = {
    async charge(request) {
      calls.charges.push(request);
      const result = await simulator.charge(request);
      calls.results.push(result);
      return result;
    },
    async lookupOrVoid(orderId) {
      calls.lookups.push(orderId);
      const result = await simulator.lookupOrVoid(orderId);
      calls.results.push(result);
      return result;
    },
  };
  return { provider, simulator, calls };
}

/** Wraps the real data-access functions and counts calls per function. */
export function countingStore(): { store: OrderStore; counts: Record<keyof OrderStore, number> } {
  const counts = {
    reserveInventory: 0,
    incrementChargeAttempt: 0,
    finalizePaid: 0,
    finalizeFailed: 0,
    retryLater: 0,
    recordLookupError: 0,
  };
  const store: OrderStore = {
    reserveInventory: (...a) => (counts.reserveInventory++, db.reserveInventory(...a)),
    incrementChargeAttempt: (...a) => (
      counts.incrementChargeAttempt++,
      db.incrementChargeAttempt(...a)
    ),
    finalizePaid: (...a) => (counts.finalizePaid++, db.finalizePaid(...a)),
    finalizeFailed: (...a) => (counts.finalizeFailed++, db.finalizeFailed(...a)),
    retryLater: (...a) => (counts.retryLater++, db.retryLater(...a)),
    recordLookupError: (...a) => (counts.recordLookupError++, db.recordLookupError(...a)),
  };
  return { store, counts };
}

export interface TestWorker {
  processor: Processor;
  registry: PassRegistry;
}

export function makeWorker(
  pool: Pool,
  provider: PaymentProvider,
  options: {
    limits?: Limits;
    hooks?: ProcessorHooks;
    store?: OrderStore;
    logger?: Logger;
    paymentTimeoutMs?: number;
  } = {},
): TestWorker {
  const registry = new PassRegistry();
  const processor = createProcessor({
    pool,
    provider,
    logger: options.logger ?? silentLogger,
    limits: options.limits ?? DEFAULT_LIMITS,
    paymentTimeoutMs: options.paymentTimeoutMs ?? 5000,
    registry,
    ...(options.store ? { store: options.store } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  return { processor, registry };
}

/** Claims every due order and runs one pass on each. */
export async function runPasses(
  pool: Pool,
  processor: Processor,
  workerId = 'test-worker',
): Promise<PassOutcome[]> {
  const claimed: ClaimedOrder[] = await claimDueOrders(pool, { workerId, limit: 100 });
  return Promise.all(claimed.map((order) => processor.process(order)));
}

export async function claimOne(pool: Pool, workerId = 'test-worker'): Promise<ClaimedOrder> {
  const [order] = await claimDueOrders(pool, { workerId, limit: 1 });
  if (!order) throw new Error('nothing to claim');
  return order;
}
