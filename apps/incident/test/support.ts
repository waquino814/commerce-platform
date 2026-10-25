import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Timers } from '../src/budget.js';
import type { ComposeContainer } from '../src/isolation.js';

/** Virtual time: timers run in order, promises are flushed between them. No real time passes. */
export class FakeTime {
  now = 0;
  private seq = 0;
  /** Real I/O in flight (fs calls): virtual time does not advance while it is pending. */
  private io = 0;
  private readonly pending = new Map<number, { at: number; seq: number; fn: () => void }>();
  readonly monotonic = { now: () => this.now };
  readonly wall = () => new Date(Date.UTC(2026, 9, 25, 14, 0, 0) + this.now);
  readonly timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = this.seq++;
      this.pending.set(id, { at: this.now + Math.max(0, ms), seq: id, fn });
      return id;
    },
    clearTimeout: (id) => {
      this.pending.delete(id as number);
    },
  };

  async flush(): Promise<void> {
    for (;;) {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
      if (this.io === 0) return;
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  /** Marks a real I/O promise, so virtual time waits for it. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.io += 1;
    return promise.finally(() => {
      this.io -= 1;
    });
  }

  /** Wraps every function of an fs-like object so its promises are tracked. */
  trackFs<T extends object>(fs: T): T {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fs)) {
      out[k] =
        typeof v === 'function'
          ? (...args: unknown[]) =>
              this.track(Promise.resolve((v as (...a: unknown[]) => unknown)(...args)))
          : v;
    }
    return out as T;
  }

  /** Runs timers in time order until `promise` settles. */
  async run<T>(promise: Promise<T>, maxSteps = 100_000): Promise<T> {
    const state = { settled: false };
    promise.then(
      () => (state.settled = true),
      () => (state.settled = true),
    );
    for (let step = 0; step < maxSteps; step += 1) {
      await this.flush();
      if (state.settled) return promise;
      const next = [...this.pending.entries()].sort(
        (a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq,
      )[0];
      if (!next) throw new Error('deadlock: nothing scheduled and the promise has not settled');
      this.pending.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].fn();
    }
    throw new Error('too many steps');
  }

  /** Advances to `at`, running the timers due by then. */
  async advanceTo(at: number): Promise<void> {
    for (;;) {
      await this.flush();
      const next = [...this.pending.entries()].sort(
        (a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq,
      )[0];
      if (!next || next[1].at > at) break;
      this.pending.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].fn();
    }
    this.now = Math.max(this.now, at);
    await this.flush();
  }
}

/** A fetch reply scheduled on the fake clock; it rejects when its signal aborts. */
export type Reply =
  | { status: number; body?: unknown; latencyMs?: number; rawBody?: string }
  | { hang: true }
  | { transportError: true; latencyMs?: number };

export function fakeFetch(
  time: FakeTime,
  route: (url: URL, init: RequestInit | undefined) => Reply,
) {
  const calls: { url: string; method: string; at: number; body?: string }[] = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      at: time.now,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    const reply = route(u, init);
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason as Error);
        return;
      }
      signal?.addEventListener('abort', () => {
        reject(signal.reason as Error);
      });
      if ('hang' in reply) return;
      if ('transportError' in reply) {
        time.timers.setTimeout(() => {
          reject(new TypeError('fetch failed'));
        }, reply.latencyMs ?? 1);
        return;
      }
      time.timers.setTimeout(() => {
        const text = reply.rawBody ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
        resolve(new Response(reply.status === 204 ? null : text, { status: reply.status }));
      }, reply.latencyMs ?? 1);
    });
  };
  return { fetch, calls };
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'incident-test-'));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const API_ID = 'a1b2c3d4e5f6a7b8';
/** A healthy, loopback-bound commerce-platform project, as `docker compose ps` is expected to show it. */
export function containers(
  over: Partial<Record<string, Partial<ComposeContainer>>> = {},
): ComposeContainer[] {
  const pub = (ip: string, port: number) => ({
    URL: ip,
    TargetPort: port,
    PublishedPort: port,
    Protocol: 'tcp',
  });
  const base: Record<string, ComposeContainer> = {
    'orders-api': {
      ID: API_ID,
      Service: 'orders-api',
      Project: 'commerce-platform',
      Image: 'commerce-platform:local',
      State: 'running',
      Health: 'healthy',
      Publishers: [pub('127.0.0.1', 3000)],
    },
    worker: {
      ID: 'b1',
      Service: 'worker',
      Project: 'commerce-platform',
      Image: 'commerce-platform:local',
      State: 'running',
      Health: 'healthy',
      Publishers: [pub('127.0.0.1', 3001)],
    },
    jaeger: {
      ID: 'c1',
      Service: 'jaeger',
      Project: 'commerce-platform',
      Image: 'jaegertracing/jaeger:2.22.0',
      State: 'running',
      Health: 'healthy',
      Publishers: [pub('127.0.0.1', 16686)],
    },
    prometheus: {
      ID: 'd1',
      Service: 'prometheus',
      Project: 'commerce-platform',
      Image: 'prom/prometheus:v3.15.0',
      State: 'running',
      Health: 'healthy',
      Publishers: [pub('127.0.0.1', 9090)],
    },
    'otel-collector': {
      ID: 'e1',
      Service: 'otel-collector',
      Project: 'commerce-platform',
      Image: 'otel/opentelemetry-collector-contrib:0.162.0',
      State: 'running',
      Health: '',
      Publishers: [],
    },
  };
  return Object.entries(base).map(([k, v]) => ({ ...v, ...(over[k] ?? {}) }));
}
