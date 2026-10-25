import { describe, expect, it } from 'vitest';
import { generatePlan, planHash, type Plan, type PlanEntry } from '../src/plan.js';
import { STEADY, type Profile } from '../src/profiles.js';
import { FakeTime, fakeFetch, type Reply } from './support.js';
import {
  createRunPrefix,
  idempotencyKey,
  MAX_IN_FLIGHT,
  MISS_TOLERANCE_MS,
  requestFor,
  runPlan,
  type HttpFetch,
  type HttpRequest,
} from '../src/runner.js';
import { buildReport, REQUEST_TIMEOUT_MS, type EntryResult } from '../src/stats.js';

/** M4 criteria 5 and 6, on a fake clock: no real time passes. */
const base = 'http://api.test';
const list = (index: number, offsetMs: number): PlanEntry => ({
  index,
  offsetMs,
  op: 'product.list',
  params: { limit: 20, after: null },
});
const create = (index: number, offsetMs: number): PlanEntry => ({
  index,
  offsetMs,
  op: 'order.create',
  params: {
    items: [{ sku: 'SKU-00001', quantity: 1 }],
    paymentMethod: 'pm_card_ok',
    keyIndex: index,
  },
});
const read = (index: number, offsetMs: number, createIndex: number): PlanEntry => ({
  index,
  offsetMs,
  op: 'order.read',
  params: { createIndex },
});
const planOf = (entries: PlanEntry[]): Plan => ({ profile: STEADY, seed: 0, entries });

/** The standard success reply for each operation. */
function okReply(latencyMs: number) {
  return (url: string, req: HttpRequest): Reply =>
    req.method === 'POST'
      ? {
          status: 201,
          body: JSON.stringify({ id: `order-${url.length}-${String(Math.random())}` }),
          latencyMs,
        }
      : { status: 200, body: '{}', latencyMs };
}

function run(time: FakeTime, plan: Plan, fetch: HttpFetch, maxInFlight?: number) {
  return time.run(
    runPlan(plan, {
      baseUrl: base,
      fetch,
      clock: time.clock,
      timers: time.timers,
      runPrefix: 'lg-test',
      timeoutSignal: time.timeoutSignal,
      ...(maxInFlight === undefined ? {} : { maxInFlight }),
    }),
  );
}

const kinds = (results: EntryResult[]) => results.map((r) => r.outcome.kind);

describe('open-loop scheduling (criterion 6)', () => {
  it('starts each request at its offset, whatever the latency of earlier ones', async () => {
    const time = new FakeTime();
    const http = fakeFetch(time, okReply(1_000));
    const entries = [0, 18.2, 36.4, 500, 2_000].map((offset, i) => list(i, offset));
    const results = await run(time, planOf(entries), http.fetch);
    expect(http.sent.map((s) => s.at)).toEqual([0, 18.2, 36.4, 500, 2_000]);
    expect(kinds(results)).toEqual(Array(5).fill('successful'));
    for (const r of results) {
      expect(r.outcome.kind === 'successful' ? r.outcome.latencyMs : -1).toBeCloseTo(1_000, 6);
    }
  });

  it('never exceeds 64 in flight, and misses entries that cannot start within 100 ms', async () => {
    expect(MAX_IN_FLIGHT).toBe(64);
    expect(MISS_TOLERANCE_MS).toBe(100);
    const time = new FakeTime();
    const http = fakeFetch(time, okReply(1_000));
    const entries = Array.from({ length: 100 }, (_, i) => list(i, 0));
    const results = await run(time, planOf(entries), http.fetch);
    expect(http.max()).toBe(64);
    expect(http.sent).toHaveLength(64);
    expect(kinds(results).filter((k) => k === 'successful')).toHaveLength(64);
    expect(kinds(results).filter((k) => k === 'missed')).toHaveLength(36);
  });

  it('starts a waiting entry when a slot frees within 100 ms, and misses it after', async () => {
    const time = new FakeTime();
    const latency = [100, 50, 60, 5];
    let call = 0;
    const http = fakeFetch(time, () => ({ status: 200, latencyMs: latency[call++] ?? 5 }));
    // Cap 1. Entry 1 waits for entry 0 and starts at exactly 100 ms after its due time: on time.
    // Entry 2 (due at 99 ms) starts when entry 1 finishes at 150 ms: 51 ms late, on time.
    // Entry 3 (due at 99 ms) would start when entry 2 finishes at 210 ms: 111 ms late, missed.
    const entries = [list(0, 0), list(1, 0), list(2, 99), list(3, 99)];
    const results = await run(time, planOf(entries), http.fetch, 1);
    expect(kinds(results)).toEqual(['successful', 'successful', 'successful', 'missed']);
    expect(http.sent.map((s) => s.at)).toEqual([0, 100, 150]);
  });

  it('skips a read whose create failed, was missed, or has not completed by its due time', async () => {
    const time = new FakeTime();
    const http = fakeFetch(time, (url, req) => {
      if (req.method === 'POST') {
        const key = req.headers['idempotency-key'] ?? '';
        if (key.endsWith('-0')) return { status: 500, latencyMs: 5 };
        if (key.endsWith('-2')) return { status: 201, body: '{"id":"slow"}', latencyMs: 3_000 };
        return { status: 201, body: '{"id":"order-4"}', latencyMs: 5 };
      }
      return { status: 200, body: '{}', latencyMs: 5 };
    });
    const entries = [
      create(0, 0), // fails with 500
      read(1, 1_000, 0), // skipped: create failed
      create(2, 1_000), // completes at 4,000 ms
      read(3, 2_000, 2), // skipped: create not completed by 2,000 ms
      create(4, 2_000), // succeeds at 2,005 ms
      read(5, 3_100, 4), // sent
    ];
    const results = await run(time, planOf(entries), http.fetch);
    expect(kinds(results)).toEqual([
      'failed',
      'skipped',
      'successful',
      'skipped',
      'successful',
      'successful',
    ]);
    expect(http.sent.map((s) => s.url)).toContain(`${base}/orders/order-4`);
    expect(http.sent.filter((s) => s.url.includes('/orders/')).map((s) => s.url)).toEqual([
      `${base}/orders/order-4`,
    ]);
  });

  it('skips a read whose create was missed', async () => {
    const time = new FakeTime();
    const http = fakeFetch(time, okReply(1_000));
    // Cap 1: the create at index 1 waits behind entry 0 for 1 s and is missed.
    const entries = [list(0, 0), create(1, 0), read(2, 1_500, 1)];
    const results = await run(time, planOf(entries), http.fetch, 1);
    expect(kinds(results)).toEqual(['successful', 'missed', 'skipped']);
  });

  it('resolves only after every sent request has finished, so nothing is left pending', async () => {
    const time = new FakeTime();
    const http = fakeFetch(time, (url) =>
      url.endsWith('after=SKU-00009')
        ? { status: 200, latencyMs: 4_000 }
        : { status: 200, latencyMs: 1 },
    );
    const entries: PlanEntry[] = [
      list(0, 0),
      { index: 1, offsetMs: 10, op: 'product.list', params: { limit: 20, after: 'SKU-00009' } },
    ];
    const results = await run(time, planOf(entries), http.fetch);
    expect(time.now).toBe(4_010);
    expect(kinds(results)).toEqual(['successful', 'successful']);
  });

  it('counts a timeout as failed at 5,000 ms and a transport error as failed', async () => {
    const time = new FakeTime();
    const http = fakeFetch(time, (url) =>
      url.includes('after=SKU-00001') ? 'hang' : 'transport-error',
    );
    const entries: PlanEntry[] = [
      { index: 0, offsetMs: 0, op: 'product.list', params: { limit: 20, after: 'SKU-00001' } },
      list(1, 0),
    ];
    const results = await run(time, planOf(entries), http.fetch);
    expect(results[0]?.outcome).toEqual({
      kind: 'failed',
      latencyMs: REQUEST_TIMEOUT_MS,
      reason: 'timeout',
    });
    expect(results[1]?.outcome).toMatchObject({ kind: 'failed', reason: 'transport' });
    expect(time.now).toBe(5_000);
  });

  it('runs the whole steady/42 plan on the fake clock with every entry accounted for', async () => {
    const time = new FakeTime();
    const http = fakeFetch(time, okReply(20));
    const plan = generatePlan(STEADY, 42);
    const results = await run(time, plan, http.fetch);
    expect(results).toHaveLength(3575);
    const report = buildReport(STEADY, results);
    expect(report.offered).toBe(3300); // 60 s at 55 rps
    expect(report.offered).toBe(report.sent + report.missed + report.skipped);
    expect(report.missed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.throughputRps).toBe(55);
    expect(http.max()).toBeLessThanOrEqual(64);
  });
});

describe('idempotency (criterion 5)', () => {
  it('sends <runPrefix>-<keyIndex> on every create, within the API key rules', async () => {
    const time = new FakeTime();
    const http = fakeFetch(time, okReply(5));
    const prefix = createRunPrefix();
    await time.run(
      runPlan(planOf([create(0, 0), create(7, 10)]), {
        baseUrl: base,
        fetch: http.fetch,
        clock: time.clock,
        timers: time.timers,
        runPrefix: prefix,
        timeoutSignal: time.timeoutSignal,
      }),
    );
    const keys = http.sent.map((s) => s.req.headers['idempotency-key']);
    expect(keys).toEqual([`${prefix}-0`, `${prefix}-7`]);
    for (const key of keys) expect(key).toMatch(/^[\x21-\x7E]{1,128}$/);
    expect(prefix).toMatch(/^lg-[0-9a-f-]{36}$/);
    expect(idempotencyKey('lg-x', 12)).toBe('lg-x-12');
  });

  it('two runs use different prefixes with the same plan hash', () => {
    const first = createRunPrefix();
    const second = createRunPrefix();
    expect(first).not.toBe(second);
    expect(planHash(generatePlan(STEADY, 42))).toBe(planHash(generatePlan(STEADY, 42)));
    expect(createRunPrefix(() => 'fixed')).toBe('lg-fixed');
  });

  it('counts a 200 replay or a 409 on a create as failed', async () => {
    const time = new FakeTime();
    let call = 0;
    const http = fakeFetch(time, () =>
      call++ === 0
        ? { status: 200, body: '{"id":"x"}', latencyMs: 5 }
        : { status: 409, latencyMs: 5 },
    );
    const results = await run(time, planOf([create(0, 0), create(1, 10)]), http.fetch);
    expect(results.map((r) => r.outcome)).toEqual([
      { kind: 'failed', latencyMs: 5, reason: 'status', status: 200 },
      { kind: 'failed', latencyMs: 5, reason: 'status', status: 409 },
    ]);
  });
});

describe('requests', () => {
  const ids = new Map([[3, 'abc']]);
  it('builds the product list, create and read requests', () => {
    expect(requestFor(list(0, 0), `${base}/`, 'p', ids)?.url).toBe(`${base}/products?limit=20`);
    expect(
      requestFor(
        { index: 0, offsetMs: 0, op: 'product.list', params: { limit: 20, after: 'SKU-00042' } },
        base,
        'p',
        ids,
      )?.url,
    ).toBe(`${base}/products?limit=20&after=SKU-00042`);
    const post = requestFor(create(3, 0), base, 'p', ids);
    expect(post).toEqual({
      url: `${base}/orders`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'p-3' },
      body: '{"items":[{"sku":"SKU-00001","quantity":1}],"paymentMethod":"pm_card_ok"}',
    });
    expect(requestFor(read(4, 0, 3), base, 'p', ids)?.url).toBe(`${base}/orders/abc`);
    expect(requestFor(read(4, 0, 9), base, 'p', ids)).toBeNull();
  });

  it('a create whose body has no id counts as successful but its reads are skipped', async () => {
    const time = new FakeTime();
    const http = fakeFetch(time, (_url, req) =>
      req.method === 'POST'
        ? { status: 201, body: 'not json', latencyMs: 5 }
        : { status: 200, latencyMs: 5 },
    );
    const results = await run(time, planOf([create(0, 0), read(1, 1_000, 0)]), http.fetch);
    expect(kinds(results)).toEqual(['successful', 'skipped']);
  });

  it('an empty plan resolves with no results', async () => {
    const empty: Profile = { ...STEADY };
    const results = await run(
      new FakeTime(),
      { profile: empty, seed: 0, entries: [] },
      fakeFetch(new FakeTime(), okReply(1)).fetch,
    );
    expect(results).toEqual([]);
  });
});
