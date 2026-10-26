import { API_BASE_URL } from './config';

/**
 * The orders API contract, as its routes return it (apps/orders-api/src/routes.ts): JSON with
 * ISO 8601 timestamps, integer cents, and errors shaped `{ error, message, details? }`.
 */
export type OrderStatus = 'pending' | 'processing' | 'payment_unknown' | 'paid' | 'failed';
export type FailureReason =
  'out_of_stock' | 'payment_declined' | 'max_attempts_exceeded' | 'invalid_order';
export type PaymentMethod = 'pm_card_ok' | 'pm_card_declined' | 'pm_card_unavailable';

export const TERMINAL_STATUSES: readonly OrderStatus[] = ['paid', 'failed'];
export const isTerminal = (status: OrderStatus) => TERMINAL_STATUSES.includes(status);

export interface Product {
  sku: string;
  name: string;
  priceCents: number;
  currency: string;
  stockAvailable: number;
}

export interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  currency: string;
  totalCents: number;
  items: OrderItem[];
  paymentMethod: PaymentMethod | null;
  paymentReference: string | null;
  processingAttempts: number;
  chargeAttempts: number;
  reconciliationAttempts: number;
  failureReason: FailureReason | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  failedAt: string | null;
}

export interface OrderSummary {
  id: string;
  status: OrderStatus;
  currency: string;
  totalCents: number;
  itemCount: number;
  totalQuantity: number;
  failureReason: FailureReason | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface NewOrder {
  items: { sku: string; quantity: number }[];
  paymentMethod: PaymentMethod;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Worth retrying: no response, a rate limit, or a server error. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal | undefined;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: { accept: 'application/json', ...options.headers },
      signal: options.signal ?? null,
      ...(options.body === undefined ? {} : { body: options.body }),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'The orders API could not be reached.');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (body ?? {}) as { error?: unknown; message?: unknown; details?: unknown };
    throw new ApiError(
      res.status,
      typeof e.error === 'string' ? e.error : 'http_error',
      typeof e.message === 'string' ? e.message : `The orders API answered ${String(res.status)}.`,
      Array.isArray(e.details) ? e.details : [],
    );
  }
  return body as T;
}

const query = (params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== null && v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const api = {
  products: (after: string | null, limit: number, signal?: AbortSignal) =>
    request<Page<Product>>(`/products${query({ limit, after })}`, { signal }),
  orders: (after: string | null, limit: number, signal?: AbortSignal) =>
    request<Page<OrderSummary>>(`/orders${query({ limit, after })}`, { signal }),
  order: (id: string, signal?: AbortSignal) =>
    request<Order>(`/orders/${encodeURIComponent(id)}`, { signal }),
  /** The Idempotency-Key makes a retry after a lost response return the same order. */
  createOrder: (order: NewOrder, idempotencyKey: string) =>
    request<Order>('/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(order),
    }),
};
