import { describe, expect, it } from 'vitest';
import { runCli, USAGE, type CliDeps } from '../src/cli.js';
import { createLoadGenerator } from '../src/index.js';
import { CATALOG_SKUS } from '../src/plan.js';
import { STEADY } from '../src/profiles.js';
import type { HttpFetch, HttpRequest } from '../src/runner.js';
import { FakeTime, fakeFetch, type Reply } from './support.js';

/** M4 criteria 1 (dry run), 8 (preflight before any planned request) and 10 (config and CLI). */
const GOLDEN = 'ba75539e9eac6c3754b0b0982d2afa0d9484cabdce827263bd38f10d850603f4';

function capture(extra: Partial<CliDeps> = {}, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    env,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ...extra,
  };
  return { deps, out: () => out.join('\n'), err: () => err.join('\n') };
}

const noNetwork: HttpFetch = () => {
  throw new Error('the network must not be used');
};

/** A stub orders API on the fake clock: ready, the seed catalog with `stock` units each. */
function apiReplies(stock: number, latencyMs: number) {
  let orders = 0;
  return (url: string, req: HttpRequest): Reply => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/readyz') return { status: 200, body: '{}', latencyMs: 1 };
    if (pathname === '/products' && searchParams.get('limit') === '100') {
      const after = searchParams.get('after');
      const start = after === null ? 0 : CATALOG_SKUS.indexOf(after) + 1;
      const page = CATALOG_SKUS.slice(start, start + 100);
      return {
        status: 200,
        body: JSON.stringify({
          items: page.map((sku) => ({ sku, stockAvailable: stock })),
          nextCursor: start + 100 < CATALOG_SKUS.length ? (page.at(-1) ?? null) : null,
        }),
        latencyMs: 1,
      };
    }
    if (req.method === 'POST') {
      orders += 1;
      return { status: 201, body: JSON.stringify({ id: `order-${String(orders)}` }), latencyMs };
    }
    return { status: 200, body: '{}', latencyMs };
  };
}

function live(time: FakeTime, http: ReturnType<typeof fakeFetch>) {
  return {
    fetch: http.fetch,
    clock: time.clock,
    timers: time.timers,
    timeoutSignal: time.timeoutSignal,
    random: () => '00000000-0000-4000-8000-000000000000',
  };
}

describe('config and CLI validation (criterion 10)', () => {
  const cases: [string[], RegExp][] = [
    [['--seed', '42'], /--profile is required/],
    [
      ['--profile', 'burst', '--seed', '42'],
      /--profile: unknown profile "burst"; available: steady/,
    ],
    [['--profile', 'steady'], /--seed is required/],
    [['--profile', 'steady', '--seed', 'abc'], /--seed: must be an integer/],
    [['--profile', 'steady', '--seed', '1.5'], /--seed: must be an integer/],
    [['--profile', 'steady', '--seed', '4294967296'], /--seed: must be an integer/],
    [['--profile', 'steady', '--seed=-1'], /--seed: must be an integer/],
    [['--profile', 'steady', '--seed', '42', '--rate', '9'], /--rate/],
    [['--profile', 'steady', '--seed', '42', 'extra'], /extra/],
  ];
  for (const [argv, message] of cases) {
    it(`exits 1 for ${argv.join(' ')}`, async () => {
      const c = capture({ fetch: noNetwork });
      expect(await runCli(argv, c.deps)).toBe(1);
      expect(c.err()).toMatch(message);
      expect(c.err()).toContain(USAGE);
    });
  }

  it('exits 1 naming ORDERS_API_URL when it is not an http(s) URL', async () => {
    for (const value of ['ftp://api.test', 'not a url']) {
      const c = capture({ fetch: noNetwork }, { ORDERS_API_URL: value });
      expect(await runCli(['--profile', 'steady', '--seed', '42', '--dry-run'], c.deps)).toBe(1);
      expect(c.err()).toMatch(/invalid configuration: ORDERS_API_URL/);
    }
  });

  it('--help prints usage and exits 0', async () => {
    const c = capture({ fetch: noNetwork });
    expect(await runCli(['--help'], c.deps)).toBe(0);
    expect(c.out()).toBe(USAGE);
  });
});

describe('dry run (criterion 1)', () => {
  it('prints the entry count, the mix and the golden hash, and sends nothing', async () => {
    const c = capture({ fetch: noNetwork });
    expect(await runCli(['--profile', 'steady', '--seed', '42', '--dry-run'], c.deps)).toBe(0);
    expect(c.out()).toContain('3575 entries');
    expect(c.out()).toContain('product.list 2103, order.create 923, order.read 549');
    expect(c.out()).toContain(`plan hash ${GOLDEN}`);
  });

  it('prints JSON with --json', async () => {
    const c = capture({ fetch: noNetwork });
    expect(
      await runCli(['--profile', 'steady', '--seed', '42', '--dry-run', '--json'], c.deps),
    ).toBe(0);
    expect(JSON.parse(c.out())).toEqual({
      profile: 'steady',
      seed: 42,
      planHash: GOLDEN,
      entries: 3575,
      byOperation: { 'product.list': 2103, 'order.create': 923, 'order.read': 549 },
      dryRun: true,
    });
  });
});

describe('live runs on a fake clock', () => {
  it('stops at a failed preflight before any planned request, with exit 1', async () => {
    const time = new FakeTime();
    // 1 unit per SKU: far more than 5% of planned quantity is unmet.
    const http = fakeFetch(time, apiReplies(1, 20));
    const c = capture(live(time, http));
    const code = await time.run(runCli(['--profile', 'steady', '--seed', '42'], c.deps));
    expect(code).toBe(1);
    expect(http.sent.every((s) => s.req.method === 'GET')).toBe(true);
    expect(http.sent.map((s) => new URL(s.url).pathname)).toEqual([
      '/readyz',
      ...Array.from({ length: 10 }, () => '/products'),
    ]);
    expect(c.out()).toContain('preflight: failed');
    expect(c.out()).toContain('short SKUs:');
    expect(c.err()).toMatch(/preflight failed: stock shortfall/);
  });

  it('runs steady/42 after a passing preflight and passes the thresholds, with exit 0', async () => {
    const time = new FakeTime();
    const http = fakeFetch(time, apiReplies(199, 20));
    const c = capture(live(time, http));
    const code = await time.run(runCli(['--profile', 'steady', '--seed', '42', '--json'], c.deps));
    expect(code).toBe(0);
    const out = JSON.parse(c.out()) as {
      planHash: string;
      runPrefix: string;
      passed: boolean;
      preflight: { passed: boolean };
      report: { offered: number; successful: number; throughputRps: number; failed: number };
    };
    expect(out.planHash).toBe(GOLDEN);
    expect(out.runPrefix).toBe('lg-00000000-0000-4000-8000-000000000000');
    expect(out.preflight.passed).toBe(true);
    expect(out.report).toMatchObject({
      offered: 3300,
      successful: 3300,
      failed: 0,
      throughputRps: 55,
    });
    expect(out.passed).toBe(true);
    // Every create carried this run's prefix.
    const keys = http.sent
      .filter((s) => s.req.method === 'POST')
      .map((s) => s.req.headers['idempotency-key'] ?? '');
    expect(keys.length).toBe(923);
    expect(keys.every((k) => k.startsWith('lg-00000000-0000-4000-8000-000000000000-'))).toBe(true);
  });

  it('fails the run with exit 1 when p95 latency reaches 200 ms, and prints the human report', async () => {
    const time = new FakeTime();
    const http = fakeFetch(time, apiReplies(199, 250));
    const c = capture(live(time, http));
    const code = await time.run(runCli(['--profile', 'steady', '--seed', '42'], c.deps));
    expect(code).toBe(1);
    expect(c.out()).toContain('preflight: passed');
    expect(c.out()).toContain('result: FAIL');
    expect(c.out()).toMatch(/FAIL p95 latency: 250\.0 ms/);
    expect(c.out()).toMatch(/offered 3300, sent \d+, successful \d+/);
  });
});

describe('factory (M5 integration)', () => {
  it('exposes the plan and its hash without running anything', () => {
    const generator = createLoadGenerator({
      profile: STEADY,
      seed: 42,
      baseUrl: 'http://api.test',
      fetch: noNetwork,
    });
    expect(generator.planHash).toBe(GOLDEN);
    expect(generator.plan.entries).toHaveLength(3575);
  });
});
