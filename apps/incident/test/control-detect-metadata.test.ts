import { SCENARIO_NAMES } from '@commerce/faults';
import { readFileSync } from 'node:fs';
import type { Condition } from '@commerce/incident-bundle';
import { describe, expect, it } from 'vitest';
import { createControl, stopProcedure } from '../src/control.js';
import { poll, renderCondition } from '../src/detect.js';
import { images, producer, services } from '../src/metadata.js';
import { FakeTime, fakeFetch, type Reply } from './support.js';

const none = {
  active: null,
  processes: { 'orders-api': { active: null }, worker: { active: null } },
};
const busy = {
  active: { scenario: 'x' },
  processes: { 'orders-api': { active: { scenario: 'x' } }, worker: { active: { scenario: 'x' } } },
};

function control(time: FakeTime, route: (url: URL, init?: RequestInit) => Reply) {
  const stub = fakeFetch(time, route);
  return {
    stub,
    control: createControl({
      baseUrl: 'http://127.0.0.1:3000',
      fetch: stub.fetch,
      timers: time.timers,
      monotonic: time.monotonic,
    }),
  };
}

describe('admin control client', () => {
  it('reads list, active, start, stop and places an order', async () => {
    const time = new FakeTime();
    const { stub, control: c } = control(time, (url, init) => {
      if (url.pathname === '/admin/scenarios')
        return { status: 200, body: { scenarios: [{ name: 'poison-order', version: 1 }] } };
      if (url.pathname === '/admin/scenarios/active') return { status: 200, body: none };
      if (url.pathname.endsWith('/start')) return { status: 202, body: {} };
      if (url.pathname === '/admin/scenarios/stop') return { status: 200, body: {} };
      if (url.pathname === '/orders' && init?.method === 'POST')
        return { status: 201, body: { id: 'o1' } };
      return { status: 200, rawBody: 'not json' };
    });
    expect((await time.run(c.list(1000))).versions?.get('poison-order')).toBe(1);
    expect(await time.run(c.active(1000))).toBe('none');
    expect(await time.run(c.start('poison-order', 42, 90_000, 1000))).toBe(202);
    expect(await time.run(c.stop(1000))).toBe(200);
    expect(await time.run(c.placeOrder('SKU-00587', 'incident-x-poison', 1000))).toBe(201);
    expect(await time.run(c.readyz(1000))).toBe(200);
    const order = stub.calls.find((x) => x.url.endsWith('/orders'));
    expect(JSON.parse(order?.body ?? '{}')).toEqual({
      items: [{ sku: 'SKU-00587', quantity: 1 }],
      paymentMethod: 'pm_card_ok',
    });
    expect(stub.calls.find((x) => x.url.endsWith('/start'))?.body).toBe(
      '{"seed":42,"durationMs":90000}',
    );
  });

  it('active is "none" only when both processes report none', async () => {
    for (const [body, status, expected] of [
      [busy, 200, 'active'],
      [
        {
          active: null,
          processes: { 'orders-api': { active: null }, worker: { error: 'worker_unavailable' } },
        },
        200,
        'unknown',
      ],
      [{ active: null, processes: { 'orders-api': { active: null } } }, 200, 'unknown'],
      [none, 503, 'unknown'],
      [{ nonsense: true }, 200, 'unknown'],
    ] as const) {
      const time = new FakeTime();
      const { control: c } = control(time, () => ({ status, body }));
      expect(await time.run(c.active(1000))).toBe(expected);
    }
    const time = new FakeTime();
    const { control: c } = control(time, () => ({ status: 404, body: { error: 'not_found' } }));
    expect(await time.run(c.list(1000))).toEqual({ status: 404 });
  });

  it('classifies transport errors and timeouts', async () => {
    const time = new FakeTime();
    const { control: down } = control(time, () => ({ transportError: true }));
    await expect(time.run(down.stop(1000))).rejects.toMatchObject({ category: 'transport' });
    const { control: slow } = control(time, () => ({ hang: true }));
    await expect(time.run(slow.stop(1000))).rejects.toMatchObject({ category: 'timeout' });
  });
});

describe('stop procedure (4.3)', () => {
  it('confirms through the report, not the stop response', async () => {
    const time = new FakeTime();
    let polls = 0;
    const { control: c } = control(time, (url) => {
      if (url.pathname === '/admin/scenarios/stop') return { status: 200 };
      polls += 1;
      return { status: 200, body: polls < 3 ? busy : none };
    });
    expect(await time.run(stopProcedure(c, time))).toEqual({
      confirmed: true,
      detail: 'confirmed',
    });
    expect(polls).toBe(3);
  });

  it('retries a failed stop once after 1 s, then confirms anyway (expiry may have ended it)', async () => {
    const time = new FakeTime();
    const { stub, control: c } = control(time, (url) =>
      url.pathname === '/admin/scenarios/stop' ? { status: 502 } : { status: 200, body: none },
    );
    const res = await time.run(stopProcedure(c, time));
    expect(res.confirmed).toBe(true);
    expect(res.detail).toMatch(/stop returned 502; stop returned 502/);
    expect(stub.calls.filter((x) => x.url.endsWith('/stop')).map((x) => x.at)).toEqual([0, 1001]);
  });

  it('is bounded at 25 s and never reports an unconfirmed stop as confirmed', async () => {
    const time = new FakeTime();
    const { control: c } = control(time, () => ({ hang: true }));
    const res = await time.run(stopProcedure(c, time));
    expect(res.confirmed).toBe(false);
    expect(time.now).toBeLessThanOrEqual(25_000);
    const t2 = new FakeTime();
    const { control: c2 } = control(t2, (url) =>
      url.pathname.endsWith('/stop') ? { status: 200 } : { status: 200, body: busy },
    );
    const res2 = await t2.run(stopProcedure(c2, t2));
    expect(res2).toEqual({ confirmed: false, detail: 'the report shows an active scenario' });
    expect(t2.now).toBeLessThanOrEqual(25_000);
  });
});

describe('detection (C10)', () => {
  const golden = (name: string) =>
    (
      JSON.parse(
        readFileSync(
          new URL(`../../../packages/faults/test/golden/${name}-42.json`, import.meta.url),
          'utf8',
        ),
      ) as { primarySymptom: Condition }
    ).primarySymptom;

  it('renders each scenario condition from the committed golden ground truths', () => {
    expect(SCENARIO_NAMES.map((n) => renderCondition(golden(n)))).toEqual([
      'sum(increase(http_server_request_duration_seconds_count{http_request_method="POST", http_response_status_code="500", http_route="/orders", job="orders-api"}[60s])) > 0',
      'sum(increase(http_server_request_duration_seconds_count{http_response_status_code="500", http_route="/orders/:id", job="orders-api"}[60s])) > 0',
      'sum(increase(commerce_payment_calls_total{job="worker", payment_operation="charge", payment_result="error"}[60s])) > 0',
      'sum(increase(commerce_claims_recovered_total{job="worker", order_status="pending"}[60s])) > 0',
      'sum(increase(commerce_payment_calls_total{job="worker", payment_operation="lookup_or_void", payment_result="error"}[60s])) > 0',
    ]);
    const gauge: Condition = {
      ...golden('poison-order'),
      evaluation: 'max_over_time',
      comparison: 'gte',
      threshold: 2,
      matchers: { a: 'x"y\\z' },
    };
    expect(renderCondition(gauge)).toBe(
      'max(max_over_time(commerce_claims_recovered_total{a="x\\"y\\\\z"}[60s])) >= 2',
    );
  });

  it('a sample is detected, an empty result is empty, and failures are never empty', async () => {
    const cases: [Reply, string][] = [
      [
        { status: 200, body: { status: 'success', data: { result: [{ value: [1, '3'] }] } } },
        'sample',
      ],
      [{ status: 200, body: { status: 'success', data: { result: [] } } }, 'empty'],
      [{ status: 503 }, 'failed'],
      [{ status: 200, body: { status: 'error' } }, 'failed'],
      [{ transportError: true }, 'failed'],
      [{ hang: true }, 'failed'],
    ];
    for (const [reply, kind] of cases) {
      const time = new FakeTime();
      const stub = fakeFetch(time, () => reply);
      const res = await time.run(
        poll(
          {
            fetch: stub.fetch,
            timers: time.timers,
            monotonic: time.monotonic,
            prometheusUrl: 'http://127.0.0.1:9090',
          },
          'up',
          4000,
        ),
      );
      expect(res.kind).toBe(kind);
    }
  });
});

describe('manifest metadata', () => {
  it('reads the producer commit and dirty flag, and fails on bad output', async () => {
    const run =
      (head: string, status: string, code = 0) =>
      (_c: string, args: readonly string[]) =>
        Promise.resolve({
          exitCode: args[0] === 'status' ? code : 0,
          stdout: args[0] === 'status' ? status : head,
          stderr: 'x',
        });
    expect(await producer(run(`${'a'.repeat(40)}\n`, ''))).toEqual({
      commit: 'a'.repeat(40),
      dirty: false,
    });
    expect(await producer(run('a'.repeat(40), ' M file\n'))).toEqual({
      commit: 'a'.repeat(40),
      dirty: true,
    });
    await expect(producer(run('not a commit', ''))).rejects.toThrow(/git rev-parse/);
    await expect(producer(run('a'.repeat(40), '', 128))).rejects.toThrow(/git status/);
  });

  it('takes images per service, and services from traces with a labeled fallback', () => {
    expect(
      images([
        { Service: 'worker', Image: 'w' },
        { Service: 'jaeger', Image: 'j' },
        { Service: 'x', Image: '' },
      ] as never),
    ).toEqual({ jaeger: 'j', worker: 'w' });
    const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const trace = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              attr('service.name', 'orders-api'),
              attr('service.version', '0.0.0'),
              attr('service.instance.id', 'abc'),
            ],
          },
          scopeSpans: [],
        },
        { resource: { attributes: [attr('service.name', 'partial')] }, scopeSpans: [] },
      ],
    };
    const metric = {
      name: 'commerce_worker_inflight',
      labels: { job: 'worker', instance: 'worker-1' },
      samples: [],
    };
    const res = services(['orders-api', 'worker', 'otel'], [trace], [metric]);
    expect(res.services).toEqual([
      { name: 'orders-api', version: '0.0.0', instanceId: 'abc' },
      { name: 'worker', version: 'unknown', instanceId: 'worker-1' },
    ]);
    expect(res.warnings).toEqual([
      'service worker has no traces; its version is "unknown" (from Prometheus labels)',
      'service otel appears in neither traces nor metrics; omitted from the manifest',
    ]);
  });
});
