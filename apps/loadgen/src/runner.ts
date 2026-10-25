import { randomUUID } from 'node:crypto';
import type { Plan, PlanEntry } from './plan.js';
import { REQUEST_TIMEOUT_MS, type EntryResult, type Outcome } from './stats.js';

/**
 * Open-loop runner (docs/prompts/m4-design.md, "Scheduling: open loop"). Each entry is due at
 * `start + offsetMs` on a monotonic clock, whatever the latency of earlier requests. At most 64
 * requests are in flight; an entry that cannot start within 100 ms of its due time is missed.
 */
export const MAX_IN_FLIGHT = 64;
export const MISS_TOLERANCE_MS = 100;

export interface HttpResponse {
  readonly status: number;
  text(): Promise<string>;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

export type HttpFetch = (url: string, request: HttpRequest) => Promise<HttpResponse>;

export interface Clock {
  /** Monotonic milliseconds. */
  now(): number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
}

export interface RunnerDeps {
  readonly baseUrl: string;
  readonly fetch: HttpFetch;
  readonly clock: Clock;
  readonly timers: Timers;
  /** Unique per run and excluded from the plan hash. */
  readonly runPrefix: string;
  /** Production uses AbortSignal.timeout; tests inject a signal their fake clock controls. */
  readonly timeoutSignal?: (ms: number) => AbortSignal;
  readonly maxInFlight?: number;
  /** M5c: called once with `clock.now()` when the plan starts, before any entry is scheduled. */
  readonly onStart?: (atMs: number) => void;
  /**
   * M5c: cancels the plan. No entry is scheduled after an abort, in-flight requests are aborted
   * (the caller's `timeoutSignal` must include this signal), and the promise rejects with the
   * signal's reason once they have settled.
   */
  readonly signal?: AbortSignal;
}

export const nodeFetch: HttpFetch = (url, request) => fetch(url, request);
export const monotonicClock: Clock = { now: () => performance.now() };
export const realTimers: Timers = { setTimeout: (fn, ms) => setTimeout(fn, ms) };

/** `lg-` plus a UUID: a visible-ASCII key prefix well inside the API's 128-character limit. */
export function createRunPrefix(uuid: () => string = randomUUID): string {
  return `lg-${uuid()}`;
}

export function idempotencyKey(runPrefix: string, keyIndex: number): string {
  return `${runPrefix}-${String(keyIndex)}`;
}

const EXPECTED_STATUS: Readonly<Record<PlanEntry['op'], number>> = {
  'product.list': 200,
  'order.create': 201,
  'order.read': 200,
};

/** The HTTP request for an entry. Reads need the order id their create received. */
export function requestFor(
  entry: PlanEntry,
  baseUrl: string,
  runPrefix: string,
  orderIds: ReadonlyMap<number, string>,
): { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string } | null {
  const base = baseUrl.replace(/\/+$/, '');
  if (entry.op === 'product.list') {
    const query = new URLSearchParams({ limit: String(entry.params.limit) });
    if (entry.params.after !== null) query.set('after', entry.params.after);
    return { url: `${base}/products?${query.toString()}`, method: 'GET', headers: {} };
  }
  if (entry.op === 'order.create') {
    return {
      url: `${base}/orders`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey(runPrefix, entry.params.keyIndex),
      },
      body: JSON.stringify({
        items: entry.params.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
        paymentMethod: entry.params.paymentMethod,
      }),
    };
  }
  const id = orderIds.get(entry.params.createIndex);
  if (id === undefined) return null;
  return { url: `${base}/orders/${encodeURIComponent(id)}`, method: 'GET', headers: {} };
}

function orderIdFrom(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

/** Runs every entry of the plan and resolves once each has exactly one outcome. */
export function runPlan(plan: Plan, deps: RunnerDeps): Promise<EntryResult[]> {
  const { clock, timers } = deps;
  const maxInFlight = deps.maxInFlight ?? MAX_IN_FLIGHT;
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const entries = plan.entries;
  const outcomes = new Array<Outcome | undefined>(entries.length);
  /** Order ids of successful creates, by plan index. */
  const orderIds = new Map<number, string>();
  /** Due entries waiting for a free slot, oldest first. */
  const waiting: { entry: PlanEntry; dueAt: number }[] = [];
  let inFlight = 0;
  let resolved = 0;
  let cancelled = false;
  const start = clock.now();

  return new Promise((resolve, reject) => {
    const rejectIfDrained = (): void => {
      if (cancelled && inFlight === 0) reject(deps.signal?.reason as Error);
    };
    const settle = (entry: PlanEntry, outcome: Outcome): void => {
      if (cancelled) return;
      if (outcomes[entry.index] !== undefined) return;
      outcomes[entry.index] = outcome;
      resolved += 1;
      if (resolved === entries.length) {
        resolve(
          entries.map((e) => ({
            index: e.index,
            offsetMs: e.offsetMs,
            op: e.op,
            outcome: outcomes[e.index] ?? { kind: 'missed' },
          })),
        );
      }
    };

    const send = (entry: PlanEntry): void => {
      const request = requestFor(entry, deps.baseUrl, deps.runPrefix, orderIds);
      if (request === null) {
        settle(entry, { kind: 'skipped' });
        return;
      }
      inFlight += 1;
      const sentAt = clock.now();
      const signal = timeoutSignal(REQUEST_TIMEOUT_MS);
      let done = false;
      const finish = (outcome: Outcome): void => {
        // Exactly once per request, so the in-flight count can never be decremented twice.
        if (done) return;
        done = true;
        inFlight -= 1;
        settle(entry, outcome);
        if (cancelled) {
          rejectIfDrained();
          return;
        }
        dispatch();
      };
      deps
        .fetch(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          signal,
        })
        .then(async (response) => {
          const body = await response.text();
          const latencyMs = clock.now() - sentAt;
          if (response.status === EXPECTED_STATUS[entry.op]) {
            if (entry.op === 'order.create') {
              const id = orderIdFrom(body);
              if (id !== undefined) orderIds.set(entry.index, id);
            }
            finish({ kind: 'successful', latencyMs, status: response.status });
          } else {
            finish({ kind: 'failed', latencyMs, reason: 'status', status: response.status });
          }
        })
        .catch(() => {
          if (signal.aborted) {
            finish({ kind: 'failed', latencyMs: REQUEST_TIMEOUT_MS, reason: 'timeout' });
          } else {
            finish({ kind: 'failed', latencyMs: clock.now() - sentAt, reason: 'transport' });
          }
        });
    };

    /** Starts waiting entries while slots are free; expired ones are missed. */
    const dispatch = (): void => {
      while (waiting.length > 0 && inFlight < maxInFlight) {
        const next = waiting.shift();
        if (next === undefined) break;
        if (clock.now() - next.dueAt > MISS_TOLERANCE_MS) {
          settle(next.entry, { kind: 'missed' });
        } else {
          send(next.entry);
        }
      }
    };

    const becomeDue = (entry: PlanEntry): void => {
      const dueAt = start + entry.offsetMs;
      // A read is skipped when its create failed, was missed, or has not completed by now.
      if (entry.op === 'order.read' && !orderIds.has(entry.params.createIndex)) {
        settle(entry, { kind: 'skipped' });
        return;
      }
      waiting.push({ entry, dueAt });
      dispatch();
      if (outcomes[entry.index] === undefined) {
        // Still waiting for a slot: miss it if none frees within the tolerance.
        timers.setTimeout(() => {
          const position = waiting.findIndex((w) => w.entry === entry);
          if (position >= 0) {
            waiting.splice(position, 1);
            settle(entry, { kind: 'missed' });
          }
        }, MISS_TOLERANCE_MS + 1);
      }
    };

    const schedule = (i: number): void => {
      const entry = entries[i];
      if (entry === undefined) return;
      const delay = Math.max(0, start + entry.offsetMs - clock.now());
      timers.setTimeout(() => {
        if (cancelled) return;
        becomeDue(entry);
        schedule(i + 1);
      }, delay);
    };

    if (deps.signal?.aborted) {
      reject(deps.signal.reason as Error);
      return;
    }
    try {
      deps.onStart?.(start);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    deps.signal?.addEventListener(
      'abort',
      () => {
        cancelled = true;
        waiting.length = 0;
        rejectIfDrained();
      },
      { once: true },
    );
    if (entries.length === 0) {
      resolve([]);
      return;
    }
    schedule(0);
  });
}
