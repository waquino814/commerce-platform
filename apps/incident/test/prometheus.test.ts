import { METRIC } from '@commerce/telemetry';
import { describe, expect, it } from 'vitest';
import {
  captureMetrics,
  CATALOG,
  PROMETHEUS_SERIES,
  prometheusNames,
} from '../src/capture/prometheus.js';
import type { HttpFetch } from '../src/capture/deps.js';

/** M5b criterion B4: Prometheus capture, against a stubbed `query_range`. */
const window = {
  captureFrom: new Date('2026-10-25T14:00:00.000Z'),
  captureTo: new Date('2026-10-25T14:03:00.000Z'),
};

function stub(
  results: Record<string, { metric: Record<string, string>; values: [number, string][] }[]>,
) {
  const urls: URL[] = [];
  const fetch: HttpFetch = (url) => {
    const u = new URL(url);
    urls.push(u);
    const name = u.searchParams.get('query') ?? '';
    return Promise.resolve(
      Response.json({
        status: 'success',
        data: { resultType: 'matrix', result: results[name] ?? [] },
      }),
    );
  };
  return { fetch, urls };
}

describe('Prometheus series mapping', () => {
  it('covers every catalog metric, and the 15 names follow the collector translation', () => {
    expect(Object.keys(CATALOG).sort()).toEqual(Object.values(METRIC).sort());
    const derived = Object.entries(CATALOG).flatMap(([metric, entry]) =>
      prometheusNames(metric, entry),
    );
    expect([...PROMETHEUS_SERIES].sort()).toEqual(derived.sort());
    expect(PROMETHEUS_SERIES).toHaveLength(15);
    expect(new Set(PROMETHEUS_SERIES).size).toBe(15);
    expect(prometheusNames('a.b', { kind: 'histogram', seconds: true })).toEqual([
      'a_b_seconds_bucket',
      'a_b_seconds_count',
      'a_b_seconds_sum',
    ]);
    expect(prometheusNames('a.b', { kind: 'counter', seconds: false })).toEqual(['a_b_total']);
    expect(prometheusNames('a.b', { kind: 'gauge', seconds: false })).toEqual(['a_b']);
  });
});

describe('captureMetrics', () => {
  it('queries each name over the window plus a minute each side at a 5 s step', async () => {
    const { fetch, urls } = stub({});
    await captureMetrics({ ...window, baseUrl: 'http://prom:9090/', fetch });
    expect(urls.map((u) => u.searchParams.get('query'))).toEqual([...PROMETHEUS_SERIES]);
    const first = urls[0];
    expect(`${first?.origin ?? ''}${first?.pathname ?? ''}`).toBe(
      'http://prom:9090/api/v1/query_range',
    );
    expect(first?.searchParams.get('start')).toBe(
      String(Date.parse('2026-10-25T13:59:00Z') / 1000),
    );
    expect(first?.searchParams.get('end')).toBe(String(Date.parse('2026-10-25T14:04:00Z') / 1000));
    expect(first?.searchParams.get('step')).toBe('5');
  });

  it('keeps value strings, drops __name__, keeps le, sorts, and records zero-series names', async () => {
    const bucket = 'http_server_request_duration_seconds_bucket';
    const { fetch } = stub({
      [bucket]: [
        { metric: { __name__: bucket, le: '+Inf', job: 'orders-api' }, values: [[1, '4']] },
        { metric: { __name__: bucket, le: '0.005', job: 'orders-api' }, values: [[1, 'NaN']] },
      ],
      commerce_orders: [
        {
          metric: { __name__: 'commerce_orders', order_status: 'paid' },
          values: [
            [1, '-Inf'],
            [6, '+Inf'],
          ],
        },
      ],
    });
    const { records, summary } = await captureMetrics({
      ...window,
      baseUrl: 'http://prom:9090',
      fetch,
    });
    expect(records).toEqual([
      {
        name: 'commerce_orders',
        labels: { order_status: 'paid' },
        samples: [
          [1, '-Inf'],
          [6, '+Inf'],
        ],
      },
      { name: bucket, labels: { job: 'orders-api', le: '+Inf' }, samples: [[1, '4']] },
      { name: bucket, labels: { job: 'orders-api', le: '0.005' }, samples: [[1, 'NaN']] },
    ]);
    expect(summary.source).toBe('prometheus');
    expect(summary.stepSeconds).toBe(5);
    expect(summary.series).toHaveLength(15);
    expect(summary.series.find((s) => s.name === bucket)?.seriesCount).toBe(2);
    expect(
      summary.series.find((s) => s.name === 'commerce_claims_released_total')?.seriesCount,
    ).toBe(0);
  });

  it('fails with the metric name on a non-200 or an unexpected body', async () => {
    const failing: HttpFetch = () =>
      Promise.resolve(Response.json({ status: 'error', error: 'bad query' }, { status: 400 }));
    await expect(
      captureMetrics({ ...window, baseUrl: 'http://p', fetch: failing }),
    ).rejects.toThrow(
      'Prometheus query_range for http_server_request_duration_seconds_bucket failed: HTTP 400: bad query',
    );
    const odd: HttpFetch = () => Promise.resolve(new Response('not json', { status: 200 }));
    await expect(captureMetrics({ ...window, baseUrl: 'http://p', fetch: odd })).rejects.toThrow(
      /HTTP 200: unexpected response/,
    );
  });
});
