import type { HttpFetch, HttpRequest } from '../src/runner.js';

/** A fake clock for the runner: virtual timers, and promises flushed between them. */
export class FakeTime {
  now = 0;
  private seq = 0;
  private readonly pending: { at: number; seq: number; fn: () => void }[] = [];
  readonly clock = { now: () => this.now };
  readonly timers = {
    setTimeout: (fn: () => void, ms: number) => {
      this.pending.push({ at: this.now + ms, seq: this.seq++, fn });
      return undefined;
    },
  };
  /** A timeout signal on this clock, as the runner's injected factory. */
  readonly timeoutSignal = (ms: number): AbortSignal => {
    const controller = new AbortController();
    this.timers.setTimeout(() => {
      controller.abort(new DOMException('timed out', 'TimeoutError'));
    }, ms);
    return controller.signal;
  };

  /** Runs timers in time order, flushing promises between them, until `promise` settles. */
  async run<T>(promise: Promise<T>): Promise<T> {
    const state = { settled: false };
    void promise.then(
      () => (state.settled = true),
      () => (state.settled = true),
    );
    for (;;) {
      for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
      if (state.settled) return promise;
      this.pending.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.pending.shift();
      if (!next) throw new Error('deadlock: nothing scheduled and the run has not finished');
      this.now = Math.max(this.now, next.at);
      next.fn();
    }
  }
}

export type Reply =
  { status: number; body?: string; latencyMs: number } | 'hang' | 'transport-error';

/** A fetch whose replies are scheduled on the fake clock. Records every request. */
export function fakeFetch(time: FakeTime, reply: (url: string, req: HttpRequest) => Reply) {
  const sent: { url: string; req: HttpRequest; at: number }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch: HttpFetch = (url, req) => {
    sent.push({ url, req, at: time.now });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const r = reply(url, req);
    return new Promise((resolve, reject) => {
      const done = () => (inFlight -= 1);
      req.signal.addEventListener('abort', () => {
        done();
        reject(req.signal.reason as Error);
      });
      if (r === 'hang') return;
      if (r === 'transport-error') {
        time.timers.setTimeout(() => {
          done();
          reject(new TypeError('fetch failed'));
        }, 1);
        return;
      }
      time.timers.setTimeout(() => {
        done();
        resolve({ status: r.status, text: () => Promise.resolve(r.body ?? '') });
      }, r.latencyMs);
    });
  };
  return { fetch, sent, max: () => maxInFlight };
}
