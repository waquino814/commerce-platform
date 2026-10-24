import { diag, DiagLogLevel } from '@opentelemetry/api';
import { DataPointType, type Histogram, type MetricData } from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it } from 'vitest';
import { createRateLimitedDiagLogger, type DiagLine } from '../src/diag.js';
import {
  createApiMetrics,
  createWorkerMetrics,
  DURATION_BUCKETS_S,
  METRIC,
  NOOP_METER_PROVIDER,
  normalizeMethod,
  observeInflight,
  observeOrderStatuses,
  observePools,
  ORDER_STATUSES,
  type OrderStatusCounts,
  type PoolStats,
} from '../src/metrics.js';
import {
  createTestMeter,
  metricNamed,
  pointsOf,
  valueAt,
  type TestMeter,
} from './metric-support.js';

type Kind = 'histogram' | 'counter' | 'observable up-down counter' | 'observable gauge';

/** The design's metrics table: name, kind, unit and label keys. */
const CATALOG: { name: string; kind: Kind; unit: string; labels: string[] }[] = [
  {
    name: 'http.server.request.duration',
    kind: 'histogram',
    unit: 's',
    labels: ['http.request.method', 'http.response.status_code', 'http.route'],
  },
  {
    name: 'db.client.connection.count',
    kind: 'observable up-down counter',
    unit: '{connection}',
    labels: ['db.client.connection.pool.name', 'db.client.connection.state'],
  },
  {
    name: 'db.client.connection.pending_requests',
    kind: 'observable up-down counter',
    unit: '{request}',
    labels: ['db.client.connection.pool.name'],
  },
  {
    name: 'db.client.connection.max',
    kind: 'observable up-down counter',
    unit: '{connection}',
    labels: ['db.client.connection.pool.name'],
  },
  { name: 'commerce.orders', kind: 'observable gauge', unit: '{order}', labels: ['order.status'] },
  {
    name: 'commerce.worker.passes',
    kind: 'counter',
    unit: '{pass}',
    labels: ['order.pass.outcome', 'order.pass.type'],
  },
  { name: 'commerce.worker.inflight', kind: 'observable gauge', unit: '{pass}', labels: [] },
  {
    name: 'commerce.payment.calls',
    kind: 'counter',
    unit: '{call}',
    labels: ['payment.operation', 'payment.replayed', 'payment.result'],
  },
  {
    name: 'commerce.payment.duration',
    kind: 'histogram',
    unit: 's',
    labels: ['payment.operation', 'payment.result'],
  },
  {
    name: 'commerce.claims.recovered',
    kind: 'counter',
    unit: '{order}',
    labels: ['order.status'],
  },
  {
    name: 'commerce.claims.released',
    kind: 'counter',
    unit: '{order}',
    labels: ['release.result'],
  },
];

/** The kind as read back from the collected data. */
function kindOf(metric: MetricData): Kind | 'other' {
  if (metric.dataPointType === DataPointType.HISTOGRAM) return 'histogram';
  if (metric.dataPointType === DataPointType.GAUGE) return 'observable gauge';
  if (metric.dataPointType === DataPointType.SUM) {
    return metric.isMonotonic ? 'counter' : 'observable up-down counter';
  }
  return 'other';
}

const fakePool = (total: number, idle: number, waiting: number, max?: number): PoolStats => ({
  totalCount: total,
  idleCount: idle,
  waitingCount: waiting,
  options: { max },
});

const counts: OrderStatusCounts = {
  pending: 3,
  processing: 1,
  paid: 7,
  failed: 2,
  payment_unknown: 0,
};

let tm: TestMeter;
afterEach(async () => {
  await tm.shutdown();
});

/** Records one value through every instrument. */
function recordEverything(meter: TestMeter['meter']): void {
  createApiMetrics(meter).recordRequest({
    method: 'POST',
    route: '/orders',
    statusCode: 201,
    durationS: 0.02,
  });
  observePools([{ name: 'worker', pool: fakePool(3, 1, 2, 6) }], meter);
  observeOrderStatuses(() => counts, meter);
  observeInflight(() => 2, meter);
  const worker = createWorkerMetrics(meter);
  worker.passCompleted('charge', 'paid');
  worker.paymentCall({ operation: 'charge', result: 'approved', replayed: false, durationS: 0.1 });
  worker.claimsRecovered('pending', 1);
  worker.claimsReleased('released', 1);
}

describe('metric catalog (criterion 13)', () => {
  it('every instrument matches the design table: name, kind, unit and label keys', async () => {
    tm = createTestMeter();
    recordEverything(tm.meter);
    const metrics = await tm.collect();

    expect(metrics.map((m) => m.descriptor.name).sort()).toEqual(CATALOG.map((c) => c.name).sort());
    expect(Object.values(METRIC).sort()).toEqual(CATALOG.map((c) => c.name).sort());
    for (const entry of CATALOG) {
      const metric = metricNamed(metrics, entry.name);
      expect(metric, entry.name).toBeDefined();
      if (!metric) continue;
      expect([entry.name, kindOf(metric)]).toEqual([entry.name, entry.kind]);
      expect([entry.name, metric.descriptor.unit]).toEqual([entry.name, entry.unit]);
      const keys = new Set(pointsOf(metrics, entry.name).flatMap((p) => Object.keys(p.attributes)));
      expect([entry.name, [...keys].sort()]).toEqual([entry.name, entry.labels]);
    }
  });

  it('histograms use the fixed buckets', async () => {
    tm = createTestMeter();
    recordEverything(tm.meter);
    const metrics = await tm.collect();
    for (const name of [METRIC.httpServerRequestDuration, METRIC.paymentDuration]) {
      const metric = metricNamed(metrics, name);
      const point = metric?.dataPoints[0];
      expect((point?.value as Histogram | undefined)?.buckets.boundaries).toEqual([
        ...DURATION_BUCKETS_S,
      ]);
    }
    expect(DURATION_BUCKETS_S).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
    ]);
  });
});

describe('label rules (criterion 13)', () => {
  it('normalizes methods to GET, POST, HEAD, OPTIONS or _OTHER', () => {
    expect(['GET', 'post', 'HEAD', 'options'].map(normalizeMethod)).toEqual([
      'GET',
      'POST',
      'HEAD',
      'OPTIONS',
    ]);
    expect(['PUT', 'DELETE', 'PATCH', 'TRACE', 'PROPFIND', ''].map(normalizeMethod)).toEqual(
      Array(6).fill('_OTHER'),
    );
  });

  it('omits http.route for unmatched routes', async () => {
    tm = createTestMeter();
    const api = createApiMetrics(tm.meter);
    api.recordRequest({ method: 'GET', route: undefined, statusCode: 404, durationS: 0.001 });
    api.recordRequest({ method: 'PATCH', route: '/orders', statusCode: 404, durationS: 0.001 });
    const points = pointsOf(await tm.collect(), METRIC.httpServerRequestDuration);
    expect(points.map((p) => p.attributes)).toEqual([
      { 'http.request.method': 'GET', 'http.response.status_code': 404 },
      {
        'http.request.method': '_OTHER',
        'http.response.status_code': 404,
        'http.route': '/orders',
      },
    ]);
  });

  it('reports all five statuses from a fresh sample, zeros included, and nothing without one', async () => {
    tm = createTestMeter();
    let sample: OrderStatusCounts | null = null;
    const stop = observeOrderStatuses(() => sample, tm.meter);
    expect(pointsOf(await tm.collect(), METRIC.orders)).toEqual([]);

    sample = counts;
    const fresh = pointsOf(await tm.collect(), METRIC.orders);
    expect(fresh.map((p) => [p.attributes['order.status'], p.value])).toEqual(
      ORDER_STATUSES.map((s) => [s, counts[s]]),
    );

    sample = null;
    expect(pointsOf(await tm.collect(), METRIC.orders)).toEqual([]);
    stop();
  });

  it('splits pool connections into idle and used, with pending requests and max', async () => {
    tm = createTestMeter();
    observePools(
      [
        { name: 'worker', pool: fakePool(4, 1, 2, 6) },
        { name: 'simulator', pool: fakePool(0, 0, 0) },
      ],
      tm.meter,
    );
    const metrics = await tm.collect();
    const at = (name: string, attrs: Record<string, string>) => valueAt(metrics, name, attrs);
    const worker = { 'db.client.connection.pool.name': 'worker' };
    const simulator = { 'db.client.connection.pool.name': 'simulator' };
    expect(at(METRIC.dbConnectionCount, { ...worker, 'db.client.connection.state': 'idle' })).toBe(
      1,
    );
    expect(at(METRIC.dbConnectionCount, { ...worker, 'db.client.connection.state': 'used' })).toBe(
      3,
    );
    expect(at(METRIC.dbConnectionPendingRequests, worker)).toBe(2);
    expect(at(METRIC.dbConnectionMax, worker)).toBe(6);
    // pg's default size when a pool has no explicit max.
    expect(at(METRIC.dbConnectionMax, simulator)).toBe(10);
  });

  it('records payment calls with replayed and an error result, and skips zero claim counts', async () => {
    tm = createTestMeter();
    const worker = createWorkerMetrics(tm.meter);
    worker.paymentCall({ operation: 'charge', result: 'error', replayed: false, durationS: 0.5 });
    worker.paymentCall({
      operation: 'lookup_or_void',
      result: 'approved',
      replayed: true,
      durationS: 0.01,
    });
    worker.claimsRecovered('payment_unknown', 0);
    worker.claimsReleased('unconfirmed', 0);
    worker.claimsReleased('unconfirmed', 2);
    const metrics = await tm.collect();
    expect(
      valueAt(metrics, METRIC.paymentCalls, {
        'payment.operation': 'charge',
        'payment.result': 'error',
        'payment.replayed': false,
      }),
    ).toBe(1);
    expect(
      valueAt(metrics, METRIC.paymentDuration, {
        'payment.operation': 'lookup_or_void',
        'payment.result': 'approved',
      }),
    ).toBe(1);
    expect(pointsOf(metrics, METRIC.claimsRecovered)).toEqual([]);
    expect(pointsOf(metrics, METRIC.claimsReleased)).toEqual([
      { attributes: { 'release.result': 'unconfirmed' }, value: 2 },
    ]);
  });

  it('stops observing when the returned function is called', async () => {
    tm = createTestMeter();
    let poolReads = 0;
    const pool: PoolStats = {
      get totalCount() {
        poolReads += 1;
        return 1;
      },
      idleCount: 1,
      waitingCount: 0,
      options: { max: 1 },
    };
    const stopPools = observePools([{ name: 'metrics', pool }], tm.meter);
    const stopInflight = observeInflight(() => 1, tm.meter);
    expect(pointsOf(await tm.collect(), METRIC.workerInflight)).toHaveLength(1);
    expect(poolReads).toBe(1);
    stopPools();
    stopInflight();
    const metrics = await tm.collect();
    expect(pointsOf(metrics, METRIC.workerInflight)).toEqual([]);
    expect(poolReads).toBe(1);
  });
});

describe('recording never throws', () => {
  afterEach(() => {
    diag.disable();
  });

  function brokenMeter(error: unknown): TestMeter['meter'] {
    const broken = () => {
      throw error;
    };
    const instrument = { add: broken, record: broken };
    return {
      createCounter: () => instrument,
      createHistogram: () => instrument,
    } as unknown as TestMeter['meter'];
  }

  function recordAll(meter: TestMeter['meter'], orderId: string): void {
    const api = createApiMetrics(meter);
    const worker = createWorkerMetrics(meter);
    api.recordRequest({
      method: 'GET',
      route: `/orders/${orderId}`,
      statusCode: 200,
      durationS: 1,
    });
    worker.passCompleted('charge', 'paid');
    worker.paymentCall({ operation: 'charge', result: 'approved', replayed: false, durationS: 1 });
    worker.claimsRecovered('pending', 1);
    worker.claimsReleased('released', 1);
  }

  it('swallows recorder errors, so an order outcome cannot change', () => {
    expect(() => {
      recordAll(brokenMeter(new Error('instrument failure')), 'order-1');
    }).not.toThrow();
  });

  it('reports them through the rate-limited diag logger, naming only the instrument and error class', () => {
    let now = 0;
    const lines: DiagLine[] = [];
    const limiter = createRateLimitedDiagLogger({ emit: (l) => lines.push(l), now: () => now });
    diag.setLogger(limiter, { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true });
    const secret = 'pm_secret_ref_123 for order 6f1c2a';
    class PaymentGatewayError extends Error {
      override name = 'PaymentGatewayError';
    }

    // 100 failing rounds: each recorder fails 100 times, within one rate-limit window.
    for (let i = 0; i < 100; i += 1)
      recordAll(brokenMeter(new PaymentGatewayError(secret)), `o-${i}`);
    expect(limiter.received).toBe(500);
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      ['warn', 'metric recording failed: http.server.request.duration (PaymentGatewayError)'],
      ['warn', 'metric recording failed: commerce.worker.passes (PaymentGatewayError)'],
      ['warn', 'metric recording failed: commerce.payment.calls (PaymentGatewayError)'],
      ['warn', 'metric recording failed: commerce.claims.recovered (PaymentGatewayError)'],
      ['warn', 'metric recording failed: commerce.claims.released (PaymentGatewayError)'],
    ]);

    // After the window, one line per kind again, carrying the suppressed count.
    now = 60_001;
    recordAll(brokenMeter(new PaymentGatewayError(secret)), 'late');
    expect(lines.slice(5).map((l) => l.suppressed)).toEqual([99, 99, 99, 99, 99]);

    // Never the error message, attribute values, order ids or raw routes.
    const text = JSON.stringify(lines);
    for (const value of [secret, 'pm_secret', 'o-1', '/orders/', 'late']) {
      expect(text).not.toContain(value);
    }
  });

  it('uses a generic error kind when the error has no plain class name', () => {
    const lines: DiagLine[] = [];
    diag.setLogger(createRateLimitedDiagLogger({ emit: (l) => lines.push(l) }), {
      logLevel: DiagLogLevel.WARN,
      suppressOverrideMessage: true,
    });
    const weird = new Error('x');
    weird.name = 'Bad name with spaces and 123-values';
    createWorkerMetrics(brokenMeter(weird)).passCompleted('charge', 'paid');
    createWorkerMetrics(brokenMeter('a thrown string')).claimsRecovered('pending', 1);
    expect(lines.map((l) => l.msg)).toEqual([
      'metric recording failed: commerce.worker.passes (Error)',
      'metric recording failed: commerce.claims.recovered (Error)',
    ]);
  });

  it('is silent with telemetry off, when no diag logger is installed', () => {
    expect(() => {
      recordAll(brokenMeter(new Error('instrument failure')), 'order-1');
    }).not.toThrow();
  });
});

describe('instrumentation isolation', () => {
  it('the instrumentations get meters that record nothing', () => {
    const meter = NOOP_METER_PROVIDER.getMeter('@opentelemetry/instrumentation-http');
    const histogram = meter.createHistogram('http.server.request.duration');
    expect(() => {
      histogram.record(1, { 'http.request.method': 'PUT' });
    }).not.toThrow();
    expect(histogram.constructor.name).toMatch(/Noop/);
  });
});
