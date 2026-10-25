import { describe, expect, it } from 'vitest';
import {
  createScenarioControl,
  createWorkerForwarder,
  type WorkerForwarder,
} from '../src/control.js';
import { createFaultController } from '../src/controller.js';
import { SCENARIO_NAMES } from '../src/scenarios.js';
import { manualTimers } from './support.js';

/** M5a criteria A4 (bounds), A5 (cross-process control) and A6 (admin contracts). */
function forwarder(
  overrides: Partial<WorkerForwarder> = {},
): WorkerForwarder & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    start: (name, body) => {
      calls.push(`start:${name}:${String(body.seed)}:${String(body.durationMs)}`);
      return Promise.resolve(true);
    },
    stop: () => {
      calls.push('stop');
      return Promise.resolve(true);
    },
    report: () => Promise.resolve({ active: null, processes: { worker: { active: null } } }),
    ...overrides,
  };
}

const api = (fwd: WorkerForwarder = forwarder()) => {
  const controller = createFaultController({ timers: manualTimers(), now: () => 0 });
  return {
    controller,
    control: createScenarioControl({ process: 'orders-api', controller, forwarder: fwd }),
  };
};

describe('scenario control contract (A6)', () => {
  it('lists the five scenarios, sorted, with the documented fields', () => {
    const { control } = api();
    const res = control.list();
    expect(res.status).toBe(200);
    const body = res.body as { scenarios: { name: string; defaultDurationMs: number }[] };
    expect(body.scenarios.map((s) => s.name)).toEqual([...SCENARIO_NAMES]);
    expect(Object.keys(body.scenarios[0] ?? {}).sort()).toEqual(
      ['affectedComponents', 'defaultDurationMs', 'description', 'name', 'version'].sort(),
    );
    expect(body.scenarios.every((s) => s.defaultDurationMs === 90_000)).toBe(true);
  });

  it('starts a scenario on both processes and returns 202 with the activation', async () => {
    const fwd = forwarder();
    const { control } = api(fwd);
    const res = await control.start('provider-outage', { seed: 42, durationMs: 90_000 });
    expect(res).toEqual({
      status: 202,
      body: {
        activation: {
          scenario: 'provider-outage',
          version: 1,
          seed: 42,
          durationMs: 90_000,
          startedAt: '1970-01-01T00:00:00.000Z',
          expiresAt: '1970-01-01T00:01:30.000Z',
          processes: { 'orders-api': 'active', worker: 'active' },
        },
      },
    });
    expect(fwd.calls).toEqual(['start:provider-outage:42:90000']);
  });

  it('validates the request: 400 validation_error with details, 404 for unknown names', async () => {
    const { control } = api();
    const invalid: unknown[] = [
      undefined,
      'x',
      {},
      { seed: 1 },
      { seed: -1, durationMs: 90_000 },
      { seed: 2 ** 32, durationMs: 90_000 },
      { seed: 1.5, durationMs: 90_000 },
      { seed: 1, durationMs: 999 },
      { seed: 1, durationMs: 600_001 },
      { seed: 1, durationMs: 90_000, extra: true },
    ];
    for (const body of invalid) {
      const res = await control.start('poison-order', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatchObject({
        error: 'validation_error',
        message: 'request validation failed',
      });
      expect((res.body as { details: unknown[] }).details.length).toBeGreaterThan(0);
    }
    expect(await control.start('missing-index', { seed: 1, durationMs: 1000 })).toEqual({
      status: 404,
      body: { error: 'scenario_not_found', message: 'no scenario named missing-index' },
    });
  });

  it('returns 409 scenario_active with the active scenario in details', async () => {
    const { control } = api();
    await control.start('poison-order', { seed: 1, durationMs: 1000 });
    const res = await control.start('payment-timeouts', { seed: 1, durationMs: 1000 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'scenario_active',
      details: [{ scenario: 'poison-order' }],
    });
  });

  it('returns 503 after shutdown', async () => {
    const { controller, control } = api();
    controller.shutdown();
    expect((await control.start('poison-order', { seed: 1, durationMs: 1000 })).status).toBe(503);
  });
});

describe('cross-process control (A5)', () => {
  it('rolls back the API activation and returns 502 when the worker does not confirm', async () => {
    const { controller, control } = api(forwarder({ start: () => Promise.resolve(false) }));
    const res = await control.start('poison-order', { seed: 1, durationMs: 1000 });
    expect(res).toEqual({
      status: 502,
      body: { error: 'worker_unavailable', message: 'the worker did not confirm the start' },
    });
    expect(controller.active()).toBeNull();
  });

  it('stop is idempotent, forwarded, and reports a worker that did not confirm', async () => {
    const fwd = forwarder();
    const { control } = api(fwd);
    await control.start('poison-order', { seed: 1, durationMs: 1000 });
    expect(await control.stop()).toEqual({
      status: 200,
      body: { stopped: true, scenario: 'poison-order' },
    });
    expect(await control.stop()).toEqual({ status: 200, body: { stopped: false, scenario: null } });
    expect(fwd.calls.filter((c) => c === 'stop')).toHaveLength(2);
    const { control: broken } = api(forwarder({ stop: () => Promise.resolve(false) }));
    expect((await broken.stop()).status).toBe(502);
  });

  it('reports both processes, including an unreachable worker', async () => {
    const { control } = api();
    await control.start('poison-order', { seed: 5, durationMs: 1000 });
    const res = await control.report();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      active: { scenario: 'poison-order', seed: 5 },
      processes: {
        'orders-api': { active: { scenario: 'poison-order' } },
        worker: { active: null },
      },
    });
    const { control: lonely } = api(forwarder({ report: () => Promise.resolve(null) }));
    expect((await lonely.report()).body).toEqual({
      active: null,
      processes: { 'orders-api': { active: null }, worker: { error: 'worker_unavailable' } },
    });
  });

  it('the worker answers for itself, without forwarding', async () => {
    const controller = createFaultController({ timers: manualTimers(), now: () => 0 });
    const control = createScenarioControl({ process: 'worker', controller });
    const started = await control.start('poison-order', { seed: 1, durationMs: 1000 });
    expect(started.body).toMatchObject({ activation: { processes: { worker: 'active' } } });
    expect((await control.report()).body).toMatchObject({
      processes: { worker: { active: { seed: 1 } } },
    });
    expect(await control.stop()).toEqual({
      status: 200,
      body: { stopped: true, scenario: 'poison-order' },
    });
  });
});

describe('worker forwarder', () => {
  function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(handler(url, init));
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it('posts start and stop to the worker and reads its report', async () => {
    const stub = stubFetch((url) =>
      url.endsWith('/start')
        ? new Response(null, { status: 202 })
        : url.endsWith('/stop')
          ? new Response(null, { status: 200 })
          : Response.json({ processes: { worker: { active: null } } }),
    );
    const fwd = createWorkerForwarder({ baseUrl: 'http://worker:3001/', fetch: stub.fn });
    expect(await fwd.start('poison-order', { seed: 1, durationMs: 1000 })).toBe(true);
    expect(await fwd.stop()).toBe(true);
    expect(await fwd.report()).toEqual({ processes: { worker: { active: null } } });
    expect(stub.calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', 'http://worker:3001/admin/scenarios/poison-order/start'],
      ['POST', 'http://worker:3001/admin/scenarios/stop'],
      ['GET', 'http://worker:3001/admin/scenarios/active'],
    ]);
    expect(stub.calls[0]?.init.body).toBe('{"seed":1,"durationMs":1000}');
  });

  it('treats errors, other statuses and bad JSON as unconfirmed', async () => {
    const failing = createWorkerForwarder({
      baseUrl: 'http://worker:3001',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(await failing.start('poison-order', { seed: 1, durationMs: 1000 })).toBe(false);
    expect(await failing.stop()).toBe(false);
    expect(await failing.report()).toBeNull();
    const odd = createWorkerForwarder({
      baseUrl: 'http://worker:3001',
      fetch: stubFetch(() => new Response('not json', { status: 200 })).fn,
    });
    expect(await odd.start('poison-order', { seed: 1, durationMs: 1000 })).toBe(false);
    expect(await odd.report()).toBeNull();
  });
});
