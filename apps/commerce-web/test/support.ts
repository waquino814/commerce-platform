import { act, cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import type { Order, OrderSummary, Product } from '../src/api';

/**
 * A stubbed fetch for rendering the UI against API-shaped responses. Each call is recorded with
 * its method, path, headers and body. A route may return a reply, an Error (no response), or a
 * pending promise (a request still in flight).
 */
export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}
export type Reply = { status?: number; body?: unknown };
export type Route = (call: Call) => Reply | Error | Promise<Reply>;

const respond = (r: Reply) =>
  ({
    ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
    status: r.status ?? 200,
    json: () =>
      r.body === undefined ? Promise.reject(new SyntaxError('no body')) : Promise.resolve(r.body),
  }) as Response;

export function stubFetch(route: Route): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const signal = init.signal;
    const r = route(call);
    if (r instanceof Error) return Promise.reject(r);
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
      void Promise.resolve(r).then((reply) => {
        resolve(respond(reply));
      });
    });
  });
  return calls;
}

/** A reply that never arrives until `release` is called. */
export function deferred(): { promise: Promise<Reply>; release: (r: Reply) => void } {
  let release!: (r: Reply) => void;
  const promise = new Promise<Reply>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Lets pending promises and zero-delay work settle under fake timers. */
export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

export const ORDER_ID = '7f1c2a9e-3b4d-4c5e-8f60-112233445566';

export function product(n: number, overrides: Partial<Product> = {}): Product {
  return {
    sku: `SKU-${String(n).padStart(5, '0')}`,
    name: `Product ${String(n)}`,
    priceCents: 1000 + n,
    currency: 'USD',
    stockAvailable: 50,
    ...overrides,
  };
}

export function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    status: 'pending',
    currency: 'USD',
    totalCents: 3085,
    items: [
      {
        sku: 'SKU-00007',
        name: 'Product 7',
        quantity: 1,
        unitPriceCents: 1007,
        lineTotalCents: 1007,
      },
      {
        sku: 'SKU-00042',
        name: 'Product 42',
        quantity: 2,
        unitPriceCents: 1039,
        lineTotalCents: 2078,
      },
    ],
    paymentMethod: 'pm_card_ok',
    paymentReference: null,
    processingAttempts: 0,
    chargeAttempts: 0,
    reconciliationAttempts: 0,
    failureReason: null,
    lastError: null,
    nextAttemptAt: '2026-10-25T12:00:00.000Z',
    createdAt: '2026-10-25T12:00:00.000Z',
    updatedAt: '2026-10-25T12:00:00.000Z',
    paidAt: null,
    failedAt: null,
    ...overrides,
  };
}

export function summary(n: number, overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    status: 'paid',
    currency: 'USD',
    totalCents: 2000 + n,
    itemCount: 2,
    totalQuantity: 3,
    failureReason: null,
    createdAt: '2026-10-25T12:00:00.000Z',
    updatedAt: '2026-10-25T12:00:05.000Z',
    ...overrides,
  };
}
