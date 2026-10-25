import { describe, expect, it } from 'vitest';
import { captureTraces } from '../src/capture/jaeger.js';
import type { HttpFetch } from '../src/capture/deps.js';

/**
 * M5b criterion B4: trace capture against a stub of Jaeger 2.22.0's `GET /api/v3/traces`, which
 * follows the source's rules: `query.searchDepth` limits the result (100 when unset), a trace
 * matches when any span of the service starts within the inclusive window, the most recently
 * stored matches win, and an empty result is 404 "No traces found".
 */
const FROM = Date.parse('2026-10-25T14:00:00.000Z');
const hexId = (n: number, length: number) => n.toString(16).padStart(length, '0');

interface StoredSpan {
  spanId: string;
  startMs: number;
  attributes?: { key: string; value: { stringValue: string } }[];
}
interface StoredTrace {
  traceId: string;
  service: string;
  spans: StoredSpan[];
}

function jaeger(store: StoredTrace[], overrides: { status?: number; body?: string } = {}) {
  const queries: URLSearchParams[] = [];
  const fetch: HttpFetch = (url) => {
    const params = new URL(url).searchParams;
    queries.push(params);
    if (overrides.status)
      return Promise.resolve(new Response(overrides.body ?? '', { status: overrides.status }));
    const service = params.get('query.serviceName');
    const min = Date.parse(params.get('query.startTimeMin') ?? '');
    const max = Date.parse(params.get('query.startTimeMax') ?? '');
    const depth = Number(params.get('query.searchDepth') ?? '0') || 100;
    const matches = [...store]
      .reverse()
      .filter(
        (t) => t.service === service && t.spans.some((s) => s.startMs >= min && s.startMs <= max),
      )
      .slice(0, depth);
    if (matches.length === 0) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { httpCode: 404, message: 'No traces found' } }), {
          status: 404,
        }),
      );
    }
    return Promise.resolve(
      Response.json({
        result: {
          resourceSpans: matches.map((t) => ({
            resource: { attributes: [{ key: 'service.name', value: { stringValue: t.service } }] },
            scopeSpans: [
              {
                scope: { name: 'scope' },
                spans: t.spans.map((s) => ({
                  traceId: t.traceId,
                  spanId: s.spanId,
                  name: 'span',
                  startTimeUnixNano: `${String(s.startMs)}000000`,
                  ...(s.attributes ? { attributes: s.attributes } : {}),
                })),
              },
            ],
          })),
        },
      }),
    );
  };
  return { fetch, queries };
}

const trace = (
  n: number,
  service: string,
  startMs: number,
  extra: StoredSpan[] = [],
): StoredTrace => ({
  traceId: hexId(n, 32),
  service,
  spans: [{ spanId: hexId(n, 16), startMs }, ...extra],
});

const base = { baseUrl: 'http://jaeger:16686/', captureFrom: new Date(FROM) };

describe('captureTraces', () => {
  it('searches 10 s slices per service with query.searchDepth=1000 and RFC 3339 bounds', async () => {
    const { fetch, queries } = jaeger([]);
    const result = await captureTraces({
      ...base,
      captureTo: new Date(FROM + 25_000),
      fetch,
      services: ['orders-api', 'worker'],
    });
    expect(
      queries.map((q) => [
        q.get('query.serviceName'),
        q.get('query.startTimeMin'),
        q.get('query.startTimeMax'),
      ]),
    ).toEqual([
      ['orders-api', '2026-10-25T14:00:00.000Z', '2026-10-25T14:00:10.000Z'],
      ['orders-api', '2026-10-25T14:00:10.000Z', '2026-10-25T14:00:20.000Z'],
      ['orders-api', '2026-10-25T14:00:20.000Z', '2026-10-25T14:00:25.000Z'],
      ['worker', '2026-10-25T14:00:00.000Z', '2026-10-25T14:00:10.000Z'],
      ['worker', '2026-10-25T14:00:10.000Z', '2026-10-25T14:00:20.000Z'],
      ['worker', '2026-10-25T14:00:20.000Z', '2026-10-25T14:00:25.000Z'],
    ]);
    expect(queries.every((q) => q.get('query.searchDepth') === '1000')).toBe(true);
    // The 404 "No traces found" of an empty slice is an empty result, not an error.
    expect(result.records).toEqual([]);
    expect(result.summary).toEqual({
      source: 'jaeger-v3',
      sliceSeconds: 10,
      minSliceSeconds: 1,
      searchDepth: 1000,
      maxTracesPerService: 5000,
      droppedAdminSpans: 0,
      services: [
        {
          name: 'orders-api',
          traces: 0,
          saturatedSlices: 0,
          truncated: false,
          truncationReasons: [],
        },
        { name: 'worker', traces: 0, saturatedSlices: 0, truncated: false, truncationReasons: [] },
      ],
    });
  });

  it('writes one trace per line, keeping resource and scope, deduplicated across slices and services', async () => {
    const store = [
      // Spans in two slices, so the trace is found twice.
      trace(1, 'orders-api', FROM + 9_000, [{ spanId: hexId(99, 16), startMs: FROM + 10_000 }]),
      trace(2, 'orders-api', FROM + 15_000),
      // The same trace ID stored for the worker as well.
      trace(2, 'worker', FROM + 16_000),
    ];
    const { fetch } = jaeger(store);
    const { records, summary } = await captureTraces({
      ...base,
      captureTo: new Date(FROM + 20_000),
      fetch,
      services: ['orders-api', 'worker'],
    });
    expect(records).toHaveLength(2);
    const first = records[0];
    expect(first?.resourceSpans).toHaveLength(1);
    expect(first?.resourceSpans[0]?.resource).toEqual({
      attributes: [{ key: 'service.name', value: { stringValue: 'orders-api' } }],
    });
    expect(first?.resourceSpans[0]?.scopeSpans[0]?.scope).toEqual({ name: 'scope' });
    expect(first?.resourceSpans[0]?.scopeSpans[0]?.spans.map((s) => s.spanId)).toEqual([
      hexId(1, 16),
      hexId(99, 16),
    ]);
    // Trace 2 keeps both services' resources, on one line.
    expect(records[1]?.resourceSpans.map((r) => JSON.stringify(r.resource))).toHaveLength(2);
    expect(summary.services.map((s) => s.traces)).toEqual([2, 1]);
  });

  it('halves a saturated slice down to 1 s, then records slice_saturated', async () => {
    // 3 traces in the same millisecond with a depth of 2: every slice containing them saturates.
    const store = [1, 2, 3].map((n) => trace(n, 'worker', FROM + 500));
    const { fetch, queries } = jaeger(store);
    const { summary, records } = await captureTraces({
      ...base,
      captureTo: new Date(FROM + 10_000),
      fetch,
      services: ['worker'],
      searchDepth: 2,
    });
    const durations = queries.map(
      (q) =>
        Date.parse(q.get('query.startTimeMax') ?? '') -
        Date.parse(q.get('query.startTimeMin') ?? ''),
    );
    expect(durations).toEqual([10_000, 5_000, 2_500, 1_250, 1_000, 250, 1_250, 2_500, 5_000]);
    expect(summary.services[0]).toEqual({
      name: 'worker',
      traces: 2,
      saturatedSlices: 1,
      truncated: true,
      truncationReasons: ['slice_saturated'],
    });
    // The two most recently stored traces are what Jaeger returned.
    expect(records.map((r) => r.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.traceId)).toEqual([
      hexId(2, 32),
      hexId(3, 32),
    ]);
  });

  it('stops at the per-service cap and records service_cap', async () => {
    const store = [1, 2, 3, 4].map((n) => trace(n, 'orders-api', FROM + n * 3_000));
    const { fetch } = jaeger(store);
    const { summary, records } = await captureTraces({
      ...base,
      captureTo: new Date(FROM + 20_000),
      fetch,
      services: ['orders-api'],
      maxTracesPerService: 3,
    });
    expect(records).toHaveLength(3);
    expect(summary.services[0]).toMatchObject({
      traces: 3,
      truncated: true,
      truncationReasons: ['service_cap'],
    });
  });

  it('reaching the cap exactly, with nothing left, is not truncation', async () => {
    const store = [1, 2].map((n) => trace(n, 'orders-api', FROM + n * 1_000));
    const { fetch } = jaeger(store);
    const { summary } = await captureTraces({
      ...base,
      captureTo: new Date(FROM + 10_000),
      fetch,
      services: ['orders-api'],
      maxTracesPerService: 2,
    });
    expect(summary.services[0]).toMatchObject({
      traces: 2,
      truncated: false,
      truncationReasons: [],
    });
  });

  it('drops /admin spans by url.path, http.target or http.route, and traces left empty', async () => {
    const attr = (key: string, value: string) => [{ key, value: { stringValue: value } }];
    const store: StoredTrace[] = [
      {
        traceId: hexId(1, 32),
        service: 'orders-api',
        spans: [
          {
            spanId: hexId(1, 16),
            startMs: FROM + 1,
            attributes: attr('url.path', '/admin/scenarios'),
          },
        ],
      },
      {
        traceId: hexId(2, 32),
        service: 'orders-api',
        spans: [
          {
            spanId: hexId(2, 16),
            startMs: FROM + 2,
            attributes: attr('http.target', '/admin?x=1'),
          },
          { spanId: hexId(3, 16), startMs: FROM + 3, attributes: attr('http.route', '/orders') },
          {
            spanId: hexId(4, 16),
            startMs: FROM + 4,
            attributes: attr('url.path', '/administrator'),
          },
          { spanId: hexId(5, 16), startMs: FROM + 5, attributes: attr('db.statement', '/admin') },
        ],
      },
    ];
    const { fetch } = jaeger(store);
    const { records, summary } = await captureTraces({
      ...base,
      captureTo: new Date(FROM + 10_000),
      fetch,
      services: ['orders-api'],
    });
    expect(summary.droppedAdminSpans).toBe(2);
    expect(records).toHaveLength(1);
    expect(records[0]?.resourceSpans[0]?.scopeSpans[0]?.spans.map((s) => s.spanId)).toEqual([
      hexId(3, 16),
      hexId(4, 16),
      hexId(5, 16),
    ]);
  });

  it('surfaces a 400, a 404 that is not "No traces found", and an unexpected body', async () => {
    const run = (fetch: HttpFetch) =>
      captureTraces({ ...base, captureTo: new Date(FROM + 1_000), fetch, services: ['worker'] });
    await expect(
      run(jaeger([], { status: 400, body: 'search depth must be in [0, 10000]' }).fetch),
    ).rejects.toThrow(
      'Jaeger trace search for worker [2026-10-25T14:00:00.000Z, 2026-10-25T14:00:01.000Z] failed: HTTP 400: search depth must be in [0, 10000]',
    );
    await expect(run(jaeger([], { status: 404, body: 'page not found' }).fetch)).rejects.toThrow(
      /HTTP 404: page not found/,
    );
    const odd: HttpFetch = () => Promise.resolve(new Response('[]', { status: 200 }));
    await expect(run(odd)).rejects.toThrow(/returned an unexpected response/);
    const notJson: HttpFetch = () => Promise.resolve(new Response('<html>', { status: 200 }));
    await expect(run(notJson)).rejects.toThrow(/returned an unexpected response/);
  });
});
