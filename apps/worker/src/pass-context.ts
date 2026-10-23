import type { ClaimedOrder, Pool, PoolClient } from '@commerce/db';
import { PaymentTimeoutError } from './payment/provider.js';

export class PassAbortedError extends Error {
  override name = 'PassAbortedError';
  constructor() {
    super('processing pass aborted');
  }
}

/** Resolves or rejects with `promise`, or rejects with PassAbortedError once `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new PassAbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new PassAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * State for one processing pass: its claim, an abort signal, and the connections it holds.
 * Aborting stops every wait and destroys the pass's connections, so Postgres rolls back any
 * transaction the pass left open. Aborting never writes anything itself.
 */
export class PassContext {
  private readonly controller = new AbortController();
  private readonly clients = new Set<PoolClient>();

  constructor(
    readonly order: ClaimedOrder,
    private readonly pool: Pool,
  ) {}

  get token(): number {
    return this.order.processingAttempts;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  throwIfAborted(): void {
    if (this.aborted) throw new PassAbortedError();
  }

  /** Runs `fn` with a dedicated connection that abort() can destroy. */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    this.throwIfAborted();
    const connecting = this.pool.connect();
    connecting
      .then((client) => {
        // The pass was aborted while connecting: give the connection straight back.
        if (this.aborted && !this.clients.has(client)) client.release();
      })
      .catch(() => undefined);
    const client = await raceAbort(connecting, this.signal);
    this.clients.add(client);
    try {
      return await raceAbort(fn(client), this.signal);
    } finally {
      if (this.clients.delete(client)) client.release();
    }
  }

  /** Calls the provider with a timeout. Any rejection means the outcome is unknown. */
  callProvider<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    this.throwIfAborted();
    let timer: NodeJS.Timeout | undefined;
    const call = fn();
    call.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new PaymentTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    return raceAbort(Promise.race([call, timeout]), this.signal).finally(() => {
      clearTimeout(timer);
    });
  }

  /** Stops the pass: rejects its pending waits and destroys its connections. */
  abort(): void {
    this.controller.abort();
    for (const client of this.clients) {
      this.clients.delete(client);
      client.release(new PassAbortedError());
    }
  }
}

/** The passes currently running in this worker, for capacity and shutdown. */
export class PassRegistry {
  private readonly active = new Map<string, PassContext>();
  private idleWaiters: (() => void)[] = [];

  start(order: ClaimedOrder, pool: Pool): PassContext {
    const ctx = new PassContext(order, pool);
    this.active.set(order.id, ctx);
    return ctx;
  }

  finish(ctx: PassContext): void {
    if (this.active.get(ctx.order.id) === ctx) this.active.delete(ctx.order.id);
    if (this.active.size === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  get size(): number {
    return this.active.size;
  }

  snapshot(): PassContext[] {
    return [...this.active.values()];
  }

  /** Resolves once no pass is running. */
  whenIdle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
