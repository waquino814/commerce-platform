import { describe, expect, it } from 'vitest';
import { createLoadGenerator } from '../src/index.js';
import { CATALOG_SKUS } from '../src/plan.js';
import { INCIDENT, STEADY, type Profile } from '../src/profiles.js';
import type { HttpRequest } from '../src/runner.js';
import { REQUEST_TIMEOUT_MS } from '../src/stats.js';
import { FakeTime, fakeFetch, type Reply } from './support.js';

/** M5c (docs/prompts/m5c-design.md, section 3): the optional lifecycle hooks, on a fake clock. */
const base = 'http://api.test';
const TINY: Profile = Object.freeze({
  ...STEADY,
  name: 'tiny',
  ratePerSecond: 10,
  durationMs: 1_000,
  warmupMs: 0,
});

function api(options: { readyz?: number | 'hang'; plan?: 'ok' | 'hang' } = {}) {
  return (url: string, req: HttpRequest): Reply => {
    const { pathname } = new URL(url);
    if (pathname === '/readyz') {
      if (options.readyz === 'hang') return 'hang';
      return { status: options.readyz ?? 200, body: '{}', latencyMs: 1 };
    }
    if (
      pathname === '/products' &&
      req.headers['idempotency-key'] === undefined &&
      !url.includes('after=SKU')
    ) {
      // The preflight's catalog page: every SKU, with plenty of stock, in one page.
      if (url.includes(`limit=100`)) {
        return {
          status: 200,
          body: JSON.stringify({
            items: CATALOG_SKUS.map((sku) => ({ sku, stockAvailable: 1_000_000 })),
            nextCursor: null,
          }),
          latencyMs: 1,
        };
      }
    }
    if (options.plan === 'hang') return 'hang';
    return req.method === 'POST'
      ? { status: 201, body: JSON.stringify({ id: 'order-1' }), latencyMs: 2 }
      : { status: 200, body: '{}', latencyMs: 2 };
  };
}

function generator(
  time: FakeTime,
  fetch: ReturnType<typeof fakeFetch>['fetch'],
  extra: object = {},
) {
  return createLoadGenerator({
    profile: TINY,
    seed: 42,
    baseUrl: base,
    clock: time.clock,
    timers: time.timers,
    timeoutSignal: time.timeoutSignal,
    fetch,
    random: () => '00000000-0000-4000-8000-000000000000',
    ...extra,
  });
}

const isPreflight = (url: string) => url.endsWith('/readyz') || url.includes('limit=100');

describe('onPlanStart', () => {
  it('fires once, after the preflight, with the clock in milliseconds', async () => {
    const time = new FakeTime();
    time.now = 1_234;
    const stub = fakeFetch(time, api());
    const calls: { atMs: number; sentBefore: string[] }[] = [];
    const run = await time.run(
      generator(time, stub.fetch, {
        onPlanStart: (atMs: number) =>
          calls.push({ atMs, sentBefore: stub.sent.map((s) => s.url) }),
      }).run(),
    );
    expect(run.preflight.passed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.atMs).toBe(stub.sent.find((s) => !isPreflight(s.url))?.at);
    expect(calls[0]?.sentBefore.every(isPreflight)).toBe(true);
    expect(calls[0]?.sentBefore.length).toBe(2);
  });

  it('is not called when the preflight fails', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, api({ readyz: 503 }));
    let called = 0;
    const run = await time.run(
      generator(time, stub.fetch, { onPlanStart: () => (called += 1) }).run(),
    );
    expect(run.preflight.passed).toBe(false);
    expect(called).toBe(0);
  });

  it('a throwing callback rejects run() before any plan request is sent', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, api());
    const failing = generator(time, stub.fetch, {
      onPlanStart: () => {
        throw new Error('hook failed');
      },
    }).run();
    await expect(time.run(failing)).rejects.toThrow('hook failed');
    expect(stub.sent.every((s) => isPreflight(s.url))).toBe(true);
  });
});

describe('signal', () => {
  it('already aborted: rejects with the reason and sends nothing', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, api());
    const controller = new AbortController();
    controller.abort(new Error('stop now'));
    await expect(
      time.run(generator(time, stub.fetch, { signal: controller.signal }).run()),
    ).rejects.toThrow('stop now');
    expect(stub.sent).toEqual([]);
  });

  it('aborted during the preflight: rejects, and the plan never starts', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, api({ readyz: 'hang' }));
    const controller = new AbortController();
    let started = false;
    const run = generator(time, stub.fetch, {
      signal: controller.signal,
      onPlanStart: () => (started = true),
    }).run();
    time.timers.setTimeout(() => {
      controller.abort(new Error('cancelled in preflight'));
    }, 10);
    await expect(time.run(run)).rejects.toThrow('cancelled in preflight');
    expect(started).toBe(false);
    expect(stub.sent.every((s) => isPreflight(s.url))).toBe(true);
  });

  it('aborted during the plan: schedules nothing more, aborts in-flight requests, settles within the request timeout', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, api({ plan: 'hang' }));
    const controller = new AbortController();
    let startedAt = -1;
    const run = generator(time, stub.fetch, {
      signal: controller.signal,
      onPlanStart: (atMs: number) => {
        startedAt = atMs;
        time.timers.setTimeout(() => {
          controller.abort(new Error('cancelled in plan'));
        }, 450);
      },
    }).run();
    let rejectedAt = -1;
    run.catch(() => (rejectedAt = time.now));
    await expect(time.run(run)).rejects.toThrow('cancelled in plan');
    const abortAt = startedAt + 450;
    expect(rejectedAt - abortAt).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
    // Entries due every 100 ms: those due by 400 ms were sent, none after the abort.
    const planSent = stub.sent.filter((s) => !isPreflight(s.url));
    expect(planSent.length).toBeGreaterThan(0);
    expect(planSent.every((s) => s.at <= abortAt)).toBe(true);
  });

  it('a signal that is never aborted changes nothing', async () => {
    const time = new FakeTime();
    const stub = fakeFetch(time, api());
    const run = await time.run(
      generator(time, stub.fetch, { signal: new AbortController().signal }).run(),
    );
    expect(run.report?.offered).toBe(10);
  });
});

describe('unchanged without the hooks', () => {
  it('plan hashes stay at their golden values', () => {
    expect(createLoadGenerator({ profile: STEADY, seed: 42, baseUrl: base }).planHash).toBe(
      'ba75539e9eac6c3754b0b0982d2afa0d9484cabdce827263bd38f10d850603f4',
    );
    expect(createLoadGenerator({ profile: INCIDENT, seed: 42, baseUrl: base }).planHash).toBe(
      'c5ff38777f042dbadcfe9cd0e3fae6d5d0c5802268dbb4b9e18697c414965353',
    );
  });
});
