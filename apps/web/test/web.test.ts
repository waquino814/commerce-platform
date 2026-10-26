import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeBundle, type BundleContents } from '@commerce/incident-bundle';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { contents, tempDir } from '../../../packages/incident-bundle/test/support.js';
import { loadWebConfig, WebConfigError } from '../src/config.js';
import type { HealthDeps, HealthReport } from '../src/health.js';
import { listIncidents, sampleTraceIds, type IncidentDetail } from '../src/incidents.js';
import { buildWebServer } from '../src/server.js';
import type { IncidentTelemetry } from '../src/telemetry.js';

/**
 * M7: the dashboard server's read-only JSON API over real bundles, written with the M5b writer into
 * temporary directories (CLAUDE.md: bundles are never committed), its health aggregation over a
 * stubbed fetch, and its serving of the built client.
 */
let cleanups: (() => void)[] = [];
let apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  for (const c of cleanups) c();
  apps = [];
  cleanups = [];
});

function scratch(): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

const CONFIG = {
  port: 3100,
  ordersApiUrl: 'http://127.0.0.1:3000',
  workerUrl: 'http://127.0.0.1:3001',
  prometheusUrl: 'http://127.0.0.1:9090',
  jaegerUrl: 'http://127.0.0.1:16686',
};

function server(
  incidentsDir: string,
  options: { clientDir?: string; health?: Partial<HealthDeps> } = {},
): FastifyInstance {
  const app = buildWebServer({
    config: { ...CONFIG, incidentsDir },
    logger: pino({ level: 'silent' }),
    clientDir: options.clientDir ?? join(incidentsDir, 'no-client'),
    ...(options.health ? { health: options.health } : {}),
  });
  apps.push(app);
  return app;
}

/** A bundle with its own ID, creation time and detection, built from the M5b test fixture. */
function bundle(
  id: string,
  createdAt: string,
  overrides: { detectedAt?: string | null; description?: string } = {},
): BundleContents {
  const c = contents();
  const scenario = id.split('-42-')[0] ?? 'payment-timeouts';
  return {
    ...c,
    manifest: {
      ...c.manifest,
      bundleId: id,
      createdAt,
      scenario: { ...c.manifest.scenario, name: scenario },
      detection:
        overrides.detectedAt === null
          ? { detectedAt: null, latencyMs: null, deadlineSeconds: 120 }
          : c.manifest.detection,
    },
    groundTruth: {
      ...c.groundTruth,
      scenario: { ...c.groundTruth.scenario, name: scenario },
      ...(overrides.description ? { description: overrides.description } : {}),
    },
  };
}

async function populated(): Promise<string> {
  const dir = scratch();
  await writeBundle(
    dir,
    bundle('payment-timeouts-42-20261025T140000Z', '2026-10-25T14:05:00.000Z'),
  );
  await writeBundle(
    dir,
    bundle('poison-order-42-20261025T150000Z', '2026-10-25T15:05:00.000Z', { detectedAt: null }),
  );
  const invalid = await writeBundle(
    dir,
    bundle('api-pool-exhaustion-42-20261025T160000Z', '2026-10-25T16:05:00.000Z'),
  );
  await writeFile(join(invalid.dir, 'metrics.jsonl'), '{not json}\n');
  await mkdir(join(dir, '.failed', 'provider-outage-42-20261025T170000Z'), { recursive: true });
  await writeFile(
    join(dir, '.failed', 'provider-outage-42-20261025T170000Z', 'failure.json'),
    JSON.stringify({
      bundleId: 'provider-outage-42-20261025T170000Z',
      stage: 'capture-traces',
      category: 'timeout',
      occurredAt: '2026-10-25T17:05:00.000Z',
    }),
  );
  await writeFile(join(dir, '.incident.lock'), '{}');
  await mkdir(join(dir, 'not-a-bundle'));
  return dir;
}

describe('configuration', () => {
  it('defaults to port 3100 and loopback upstreams, and validates', () => {
    expect(loadWebConfig({})).toEqual({ ...CONFIG, incidentsDir: 'incidents' });
    expect(
      loadWebConfig({
        WEB_PORT: '4000',
        JAEGER_URL: 'http://127.0.0.1:16686/',
        PROMETHEUS_URL: '',
      }),
    ).toMatchObject({
      port: 4000,
      jaegerUrl: 'http://127.0.0.1:16686',
      prometheusUrl: CONFIG.prometheusUrl,
    });
    expect(loadWebConfig({ WORKER_HEALTH_URL: 'http://[::1]:3001' }).workerUrl).toBe(
      'http://[::1]:3001',
    );
    expect(() => loadWebConfig({ WEB_PORT: '80' })).toThrow(WebConfigError);
    expect(() => loadWebConfig({ WEB_PORT: 'abc' })).toThrow(/WEB_PORT/);
    expect(() => loadWebConfig({ JAEGER_URL: 'javascript:alert(1)' })).toThrow(/JAEGER_URL/);
    expect(() => loadWebConfig({ ORDERS_API_URL: 'http://example.com' })).toThrow(/ORDERS_API_URL/);
    expect(() => loadWebConfig({ PROMETHEUS_URL: 'https://127.0.0.1:9090' })).toThrow(
      /PROMETHEUS_URL/,
    );
  });
});

describe('GET /api/incidents', () => {
  it('lists every bundle newest first with detection, ground-truth symptom and validation, plus failed evidence', async () => {
    const app = server(await populated());
    const res = await app.inject({ method: 'GET', url: '/api/incidents' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Awaited<ReturnType<typeof listIncidents>>>();
    expect(body.directoryExists).toBe(true);
    expect(
      body.incidents.map((i) => [i.scenario, i.detection.status, i.validation.valid, i.complete]),
    ).toEqual([
      ['api-pool-exhaustion', 'detected', false, false],
      ['poison-order', 'not_detected', true, true],
      ['payment-timeouts', 'detected', true, true],
    ]);
    expect(body.incidents[2]).toMatchObject({
      seed: 42,
      detection: { latencyMs: 3000, deadlineSeconds: 120 },
      primarySymptom: { description: 'Charges fail.', metric: 'commerce_payment_calls_total' },
      traces: [{ service: 'orders-api', traces: 1, truncated: false }],
    });
    expect(body.failed).toEqual([
      {
        directory: 'provider-outage-42-20261025T170000Z',
        bundleId: 'provider-outage-42-20261025T170000Z',
        stage: 'capture-traces',
        category: 'timeout',
        occurredAt: '2026-10-25T17:05:00.000Z',
        files: ['failure.json'],
      },
    ]);
  });

  it('distinguishes a missing directory from an empty one', async () => {
    const missing = server(join(scratch(), 'nope'));
    expect((await missing.inject({ method: 'GET', url: '/api/incidents' })).json()).toEqual({
      directoryExists: false,
      incidents: [],
      failed: [],
    });
    const empty = server(scratch());
    expect((await empty.inject({ method: 'GET', url: '/api/incidents' })).json()).toEqual({
      directoryExists: true,
      incidents: [],
      failed: [],
    });
  });

  it('answers 500 with the error shape when the directory cannot be read', async () => {
    const dir = scratch();
    const file = join(dir, 'a-file');
    await writeFile(file, 'x');
    const res = await server(file).inject({ method: 'GET', url: '/api/incidents' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'internal_error',
      message: 'The incident evidence could not be read.',
    });
  });
});

describe('GET /api/incidents/:id', () => {
  it('returns ground truth, run window, validation, evidence files and the Jaeger base URL', async () => {
    const app = server(await populated());
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/payment-timeouts-42-20261025T140000Z',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<IncidentDetail & { jaegerUrl: string }>();
    expect(body).toMatchObject({
      jaegerUrl: 'http://127.0.0.1:16686',
      trigger: { startedAt: '2026-10-25T14:00:05.000Z', stoppedAt: '2026-10-25T14:00:20.000Z' },
      window: { loadStartedAt: '2026-10-25T14:00:00.000Z' },
      producer: { commit: 'c'.repeat(40), dirty: false },
      groundTruth: {
        description: 'A description.',
        affectedComponents: ['payment-provider', 'worker'],
        rootCause: { component: 'payment-provider', summary: 'A summary.' },
        primarySymptom: { metric: 'commerce_payment_calls_total', evaluation: 'increase' },
        expectedRemediation: ['A step.'],
      },
      validationErrors: [],
      sampleTraceIds: ['a'.repeat(32)],
    });
    expect(body.files.map((f) => f.name)).toEqual([
      'manifest.json',
      'ground_truth.json',
      'traces.jsonl',
      'metrics.jsonl',
      'logs.jsonl',
    ]);
    expect(body.files.every((f) => typeof f.bytes === 'number' && f.bytes > 0)).toBe(true);
  });

  it('lists the validator errors of an invalid bundle', async () => {
    const app = server(await populated());
    const body = (
      await app.inject({
        method: 'GET',
        url: '/api/incidents/api-pool-exhaustion-42-20261025T160000Z',
      })
    ).json<IncidentDetail>();
    expect(body.validation.valid).toBe(false);
    expect(body.validationErrors).toContainEqual(
      expect.objectContaining({
        file: 'metrics.jsonl',
        message: expect.stringMatching(/malformed JSON/) as unknown,
      }),
    );
  });

  it('returns 404 for unknown, malformed and traversal IDs', async () => {
    const app = server(await populated());
    for (const id of [
      'payment-timeouts-42-20261025T999999Z',
      '..%2F..%2Fetc',
      'not-a-bundle',
      '.failed',
    ]) {
      for (const suffix of ['', '/telemetry']) {
        const res = await app.inject({ method: 'GET', url: `/api/incidents/${id}${suffix}` });
        expect(res.statusCode, id + suffix).toBe(404);
      }
    }
    expect((await app.inject({ method: 'GET', url: '/api/incidents/nope' })).json()).toEqual({
      error: 'incident_not_found',
      message: 'no incident bundle nope',
    });
  });
});

describe('GET /api/incidents/:id/telemetry', () => {
  it('derives the symptom series, a log summary and trace samples from the bundle files', async () => {
    const app = server(await populated());
    const res = await app.inject({
      method: 'GET',
      url: '/api/incidents/payment-timeouts-42-20261025T140000Z/telemetry',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<IncidentTelemetry>()).toEqual({
      symptom: {
        metric: 'commerce_payment_calls_total',
        matchers: { job: 'worker', payment_result: 'error' },
        // The NaN sample is dropped; only finite values are charted.
        series: [
          { labels: { job: 'worker', payment_result: 'error' }, samples: [[1792940630, 3]] },
        ],
        triggerStartedAt: '2026-10-25T14:00:05.000Z',
        triggerStoppedAt: '2026-10-25T14:00:20.000Z',
        detectedAt: '2026-10-25T14:00:08.000Z',
      },
      logs: {
        total: 1,
        byLevel: { error: 1 },
        byService: { 'orders-api': 1 },
        sampleErrors: [
          {
            time: '2026-10-25T14:00:06.000Z',
            service: 'orders-api',
            message: 'request errored',
            traceId: 'a'.repeat(32),
          },
        ],
      },
      traces: {
        total: 1,
        samples: [
          {
            traceId: 'a'.repeat(32),
            rootName: 'POST /orders',
            services: ['orders-api'],
            spanCount: 2,
            durationMs: 0,
            startTime: '1970-01-01T00:00:00.000Z',
            error: false,
          },
        ],
      },
    });
  });

  it('puts error traces first, skips malformed lines and other series, and tolerates missing files', async () => {
    const dir = scratch();
    const c = contents();
    const id = 'payment-timeouts-42-20261025T140000Z';
    const span = (trace: string, name: string, start: string, extra: object = {}) => ({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'worker' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: trace,
                  spanId: '1'.repeat(16),
                  name,
                  startTimeUnixNano: start,
                  endTimeUnixNano: '5000000',
                  ...extra,
                },
              ],
            },
          ],
        },
      ],
    });
    const written = await writeBundle(dir, {
      ...c,
      traces: [
        span('b'.repeat(32), 'ok', '1000000'),
        span('c'.repeat(32), 'boom', '2000000', { status: { code: 2 } }),
      ],
      metrics: [
        ...c.metrics,
        {
          name: 'commerce_payment_calls_total',
          labels: { job: 'worker', payment_result: 'ok' },
          samples: [[1, '9']],
        },
      ],
    });
    await writeFile(join(written.dir, 'logs.jsonl'), '{not json}\n\n{"level":"warn"}\n');
    const t = (
      await server(dir).inject({ method: 'GET', url: `/api/incidents/${id}/telemetry` })
    ).json<IncidentTelemetry>();
    expect(t.traces.samples.map((s) => [s.rootName, s.error, s.durationMs])).toEqual([
      ['boom', true, 3],
      ['ok', false, 4],
    ]);
    expect(t.symptom?.series).toHaveLength(1);
    expect(t.logs).toEqual({
      total: 1,
      byLevel: { warn: 1 },
      byService: { unknown: 1 },
      sampleErrors: [],
    });

    const bare = scratch();
    await mkdir(join(bare, id));
    expect(
      (await server(bare).inject({ method: 'GET', url: `/api/incidents/${id}/telemetry` })).json(),
    ).toEqual({
      symptom: null,
      logs: { total: 0, byLevel: {}, byService: {}, sampleErrors: [] },
      traces: { total: 0, samples: [] },
    });
  });
});

describe('evidence files', () => {
  it('serves only the known bundle files, read-only', async () => {
    const app = server(await populated());
    const ok = await app.inject({
      method: 'GET',
      url: '/api/incidents/payment-timeouts-42-20261025T140000Z/files/metrics.jsonl',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(ok.body).toContain('commerce_payment_calls_total');
    for (const url of [
      '/api/incidents/payment-timeouts-42-20261025T140000Z/files/..%2F..%2Fpackage.json',
      '/api/incidents/payment-timeouts-42-20261025T140000Z/files/failure.json',
      '/api/incidents/payment-timeouts-42-20261025T999999Z/files/metrics.jsonl',
      '/api/incidents/..%2F.failed/files/manifest.json',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });

  it('accepts no writes: other methods are not found', async () => {
    const app = server(await populated());
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      for (const url of ['/api/incidents', '/api/health', '/']) {
        expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(404);
      }
    }
  });
});

describe('GET /api/health', () => {
  const report = async (route: (url: string) => Response | Error) => {
    const urls: string[] = [];
    let t = 0;
    const app = server(scratch(), {
      health: {
        fetch: (url) => {
          urls.push(url);
          const r = route(url);
          return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
        },
        now: () => (t += 5),
        wallClock: () => new Date('2026-10-25T18:00:00.000Z'),
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    return { body: res.json<HealthReport>(), urls };
  };

  it('reports each component from its own readiness endpoint, and the active scenario', async () => {
    const { body, urls } = await report((url) =>
      url.endsWith('/admin/scenarios/active')
        ? Response.json({ active: { scenario: 'poison-order' } })
        : new Response('ok'),
    );
    expect(urls.sort()).toEqual([
      'http://127.0.0.1:16686/',
      'http://127.0.0.1:3000/admin/scenarios/active',
      'http://127.0.0.1:3000/readyz',
      'http://127.0.0.1:3001/readyz',
      'http://127.0.0.1:9090/-/ready',
    ]);
    expect(body.checkedAt).toBe('2026-10-25T18:00:00.000Z');
    expect(body.components.map((c) => [c.name, c.status, c.httpStatus, c.detail])).toEqual([
      ['orders-api', 'up', 200, 'HTTP 200'],
      ['worker', 'up', 200, 'HTTP 200'],
      ['prometheus', 'up', 200, 'HTTP 200'],
      ['jaeger', 'up', 200, 'HTTP 200'],
    ]);
    expect(body.components.every((c) => typeof c.latencyMs === 'number')).toBe(true);
    expect(body.faults).toEqual({ controls: 'enabled', activeScenario: 'poison-order' });
  });

  it('distinguishes down, unreachable and timed out, and disabled or unknown fault controls', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const { body } = await report((url) => {
      if (url.includes(':3000/readyz')) return new Response('no', { status: 503 });
      if (url.includes(':3001')) return new TypeError('fetch failed');
      if (url.includes(':9090')) return timeout;
      if (url.endsWith('/admin/scenarios/active')) return new Response('', { status: 404 });
      return Response.json({ active: null });
    });
    expect(
      body.components.map((c) => [c.name, c.status, c.httpStatus, c.latencyMs === null, c.detail]),
    ).toEqual([
      ['orders-api', 'down', 503, false, 'HTTP 503'],
      ['worker', 'unreachable', null, true, 'no response'],
      ['prometheus', 'unreachable', null, true, 'timed out'],
      ['jaeger', 'up', 200, false, 'HTTP 200'],
    ]);
    expect(body.faults).toEqual({ controls: 'disabled', activeScenario: null });

    for (const [reply, expected] of [
      [new Response('', { status: 502 }), { controls: 'unknown', activeScenario: null }],
      [new Error('down'), { controls: 'unknown', activeScenario: null }],
      [Response.json({ active: null }), { controls: 'enabled', activeScenario: null }],
    ] as const) {
      const { body: b } = await report((url) =>
        url.endsWith('/active') ? reply : new Response('ok'),
      );
      expect(b.faults).toEqual(expected);
    }
  });
});

describe('client serving', () => {
  async function client(): Promise<string> {
    const dir = scratch();
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    await writeFile(join(dir, 'assets', 'index-abc123.css'), 'body{}');
    return dir;
  }

  it('serves index.html for client routes, with security headers and no caching', async () => {
    const app = server(scratch(), { clientDir: await client() });
    for (const url of [
      '/',
      '/health',
      '/incidents/payment-timeouts-42-20261025T140000Z',
      '/anything',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('id="root"');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: 'not_found' });
  });

  it('serves built assets with immutable caching, and nothing outside the assets directory', async () => {
    const app = server(scratch(), { clientDir: await client() });
    const js = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toContain('immutable');
    expect(
      (await app.inject({ method: 'GET', url: '/assets/index-abc123.css' })).headers[
        'content-type'
      ],
    ).toBe('text/css; charset=utf-8');
    for (const url of ['/assets/missing.js', '/assets/..%2Findex.html', '/assets/index.html']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });

  it('explains how to build the client when it is missing, while the API keeps working', async () => {
    const app = server(scratch());
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/pnpm build/);
    expect((await app.inject({ method: 'GET', url: '/api/incidents' })).statusCode).toBe(200);
  });
});

describe('sampleTraceIds', () => {
  it('stops early and tolerates a missing file', async () => {
    const dir = scratch();
    const path = join(dir, 'traces.jsonl');
    await writeFile(
      path,
      Array.from(
        { length: 10 },
        (_, i) =>
          `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"${String(i).repeat(32)}"}]}]}]}`,
      ).join('\n'),
    );
    expect(await sampleTraceIds(path, 2)).toEqual(['0'.repeat(32), '1'.repeat(32)]);
    expect(await sampleTraceIds(join(dir, 'missing.jsonl'), 3)).toEqual([]);
  });
});
