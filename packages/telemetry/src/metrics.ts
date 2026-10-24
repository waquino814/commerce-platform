import {
  createNoopMeter,
  diag,
  metrics,
  ValueType,
  type Attributes,
  type BatchObservableResult,
  type Meter,
  type MeterProvider,
  type ObservableResult,
} from '@opentelemetry/api';

/**
 * The M3c metric catalog (docs/prompts/m3-design.md, "Metrics"). These 11 instruments are the only
 * metrics the apps export. Every label value comes from a closed set: order ids, SKUs, raw URLs,
 * payment references, error messages, failure reasons, processing tokens and attempt counts are
 * never labels. They belong on spans and logs.
 *
 * Recording is synchronous and in memory, never awaited, and never throws, so it cannot change an
 * order outcome. With telemetry disabled the global meter is a no-op.
 */
export const METER_NAME = '@commerce/telemetry';

export const METRIC = {
  httpServerRequestDuration: 'http.server.request.duration',
  dbConnectionCount: 'db.client.connection.count',
  dbConnectionPendingRequests: 'db.client.connection.pending_requests',
  dbConnectionMax: 'db.client.connection.max',
  orders: 'commerce.orders',
  workerPasses: 'commerce.worker.passes',
  workerInflight: 'commerce.worker.inflight',
  paymentCalls: 'commerce.payment.calls',
  paymentDuration: 'commerce.payment.duration',
  claimsRecovered: 'commerce.claims.recovered',
  claimsReleased: 'commerce.claims.released',
} as const;

/** Explicit histogram buckets in seconds, so bucket labels are fixed. */
export const DURATION_BUCKETS_S: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
]);

export const ORDER_STATUSES = [
  'pending',
  'processing',
  'paid',
  'failed',
  'payment_unknown',
] as const;
export type OrderStatusLabel = (typeof ORDER_STATUSES)[number];
export type OrderStatusCounts = Readonly<Record<OrderStatusLabel, number>>;

export const POOL_NAMES = ['orders-api', 'worker', 'simulator', 'metrics'] as const;
export type PoolName = (typeof POOL_NAMES)[number];

export const HTTP_METHODS = ['GET', 'POST', 'HEAD', 'OPTIONS'] as const;

export type PassTypeLabel = 'charge' | 'reconciliation';
export type PassOutcomeLabel =
  | 'paid'
  | 'failed'
  | 'retry_scheduled'
  | 'reconciliation_retry'
  | 'parked'
  | 'claim_lost'
  | 'aborted'
  | 'error';
export type PaymentOperation = 'charge' | 'lookup_or_void';
export type PaymentResultLabel = 'approved' | 'declined' | 'voided' | 'error';
export type RecoveredStatus = 'pending' | 'payment_unknown';
export type ReleaseResultLabel = 'released' | 'unconfirmed';

/** `GET`, `POST`, `HEAD` or `OPTIONS`; any other method becomes `_OTHER`. */
export function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return (HTTP_METHODS as readonly string[]).includes(upper) ? upper : '_OTHER';
}

/**
 * Hands out no-op meters. The HTTP and pg auto-instrumentations get this provider, so they keep
 * their traces but record no metrics: their own metrics reuse catalog names with labels outside
 * the catalog (ten HTTP methods, server address and port, and pool names derived from the
 * connection string).
 */
export const NOOP_METER_PROVIDER: MeterProvider = Object.freeze({
  getMeter: () => createNoopMeter(),
});

const meterOf = (meter: Meter | undefined): Meter => meter ?? metrics.getMeter(METER_NAME);

/** The error's class name if it is a plain identifier, else "Error": never a message or value. */
function errorKind(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : 'Error';
}

/**
 * Runs a recording and never lets it throw. The OpenTelemetry API is designed not to throw, but
 * recorders sit next to payment results and pass outcomes, so the catalog guarantees it: a metric
 * can never turn a known result into an unknown one, or make a pass reject.
 *
 * An unexpected failure is reported through OpenTelemetry's diagnostic logger, which the SDK routes
 * to the rate-limited logger (one line per kind per minute, with a suppressed count). The line
 * names only the instrument and the error class, never attribute values or the error message, so
 * it carries nothing high-cardinality or sensitive. With telemetry off, diag is a no-op.
 */
function safely(instrument: string, record: () => void): void {
  try {
    record();
  } catch (err) {
    try {
      diag.warn(`metric recording failed: ${instrument} (${errorKind(err)})`);
    } catch {
      // Telemetry loss is acceptable; changing an order outcome is not.
    }
  }
}

export interface ApiMetrics {
  /**
   * Records one request. `route` is Fastify's route template, or undefined for unmatched routes,
   * in which case the label is omitted. Callers exclude health probes.
   */
  recordRequest(request: {
    method: string;
    route: string | undefined;
    statusCode: number;
    durationS: number;
  }): void;
}

/**
 * Must be called after the meter provider is registered: on API 1.9 a meter taken earlier stays a
 * no-op. The production preload registers it before the app's main module runs.
 */
export function createApiMetrics(meter?: Meter): ApiMetrics {
  const duration = meterOf(meter).createHistogram(METRIC.httpServerRequestDuration, {
    description: 'Duration of HTTP server requests.',
    unit: 's',
    valueType: ValueType.DOUBLE,
    advice: { explicitBucketBoundaries: [...DURATION_BUCKETS_S] },
  });
  return {
    recordRequest({ method, route, statusCode, durationS }) {
      safely(METRIC.httpServerRequestDuration, () => {
        const attributes: Attributes = {
          'http.request.method': normalizeMethod(method),
          'http.response.status_code': statusCode,
        };
        if (route) attributes['http.route'] = route;
        duration.record(durationS, attributes);
      });
    },
  };
}

export interface WorkerMetrics {
  passCompleted(type: PassTypeLabel, outcome: PassOutcomeLabel): void;
  /** One provider call with a known result, or `error` when the outcome is unknown. */
  paymentCall(call: {
    operation: PaymentOperation;
    result: PaymentResultLabel;
    replayed: boolean;
    durationS: number;
  }): void;
  claimsRecovered(status: RecoveredStatus, count: number): void;
  claimsReleased(result: ReleaseResultLabel, count: number): void;
}

/** See createApiMetrics for when to call it. */
export function createWorkerMetrics(meter?: Meter): WorkerMetrics {
  const m = meterOf(meter);
  const passes = m.createCounter(METRIC.workerPasses, {
    description: 'Completed worker passes.',
    unit: '{pass}',
  });
  const calls = m.createCounter(METRIC.paymentCalls, {
    description: 'Payment provider calls.',
    unit: '{call}',
  });
  const duration = m.createHistogram(METRIC.paymentDuration, {
    description: 'Duration of payment provider calls.',
    unit: 's',
    valueType: ValueType.DOUBLE,
    advice: { explicitBucketBoundaries: [...DURATION_BUCKETS_S] },
  });
  const recovered = m.createCounter(METRIC.claimsRecovered, {
    description: 'Expired claims recovered, by target status.',
    unit: '{order}',
  });
  const released = m.createCounter(METRIC.claimsReleased, {
    description: 'Claims released at shutdown, by result.',
    unit: '{order}',
  });
  return {
    passCompleted(type, outcome) {
      safely(METRIC.workerPasses, () => {
        passes.add(1, { 'order.pass.type': type, 'order.pass.outcome': outcome });
      });
    },
    paymentCall({ operation, result, replayed, durationS }) {
      safely(METRIC.paymentCalls, () => {
        calls.add(1, {
          'payment.operation': operation,
          'payment.result': result,
          'payment.replayed': replayed,
        });
        duration.record(durationS, { 'payment.operation': operation, 'payment.result': result });
      });
    },
    claimsRecovered(status, count) {
      safely(METRIC.claimsRecovered, () => {
        if (count > 0) recovered.add(count, { 'order.status': status });
      });
    },
    claimsReleased(result, count) {
      safely(METRIC.claimsReleased, () => {
        if (count > 0) released.add(count, { 'release.result': result });
      });
    },
  };
}

/** The parts of a `pg` pool the connection metrics read. */
export interface PoolStats {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  readonly options: { max?: number | undefined };
}

/** pg's default pool size, used when a pool was created without `max`. */
const PG_DEFAULT_MAX = 10;

/**
 * Observes connection counts, pending requests and pool size for the given named pools. Returns
 * a function that stops observing.
 */
export function observePools(
  pools: readonly { name: PoolName; pool: PoolStats }[],
  meter?: Meter,
): () => void {
  const m = meterOf(meter);
  const count = m.createObservableUpDownCounter(METRIC.dbConnectionCount, {
    description: 'Connections in each pool, by state.',
    unit: '{connection}',
  });
  const pending = m.createObservableUpDownCounter(METRIC.dbConnectionPendingRequests, {
    description: 'Requests waiting for a connection.',
    unit: '{request}',
  });
  const max = m.createObservableUpDownCounter(METRIC.dbConnectionMax, {
    description: 'Maximum connections allowed in each pool.',
    unit: '{connection}',
  });
  const callback = (result: BatchObservableResult): void => {
    for (const { name, pool } of pools) {
      const poolName = { 'db.client.connection.pool.name': name };
      const idle = pool.idleCount;
      result.observe(count, idle, { ...poolName, 'db.client.connection.state': 'idle' });
      result.observe(count, Math.max(0, pool.totalCount - idle), {
        ...poolName,
        'db.client.connection.state': 'used',
      });
      result.observe(pending, pool.waitingCount, poolName);
      result.observe(max, pool.options.max ?? PG_DEFAULT_MAX, poolName);
    }
  };
  m.addBatchObservableCallback(callback, [count, pending, max]);
  return () => {
    m.removeBatchObservableCallback(callback, [count, pending, max]);
  };
}

/** Observes the number of passes in flight. Returns a function that stops observing. */
export function observeInflight(read: () => number, meter?: Meter): () => void {
  const gauge = meterOf(meter).createObservableGauge(METRIC.workerInflight, {
    description: 'Worker passes in flight.',
    unit: '{pass}',
  });
  const callback = (result: ObservableResult): void => {
    result.observe(read());
  };
  gauge.addCallback(callback);
  return () => {
    gauge.removeCallback(callback);
  };
}

/**
 * Observes order counts by status from `read`, which must return a cached sample and never query.
 * A fresh sample reports all five statuses, zeros included; `null` (missing or stale) reports
 * nothing. Returns a function that stops observing.
 */
export function observeOrderStatuses(
  read: () => OrderStatusCounts | null,
  meter?: Meter,
): () => void {
  const gauge = meterOf(meter).createObservableGauge(METRIC.orders, {
    description: 'Orders by status, from the latest fresh sample.',
    unit: '{order}',
  });
  const callback = (result: ObservableResult): void => {
    const counts = read();
    if (!counts) return;
    for (const status of ORDER_STATUSES) {
      result.observe(counts[status], { 'order.status': status });
    }
  };
  gauge.addCallback(callback);
  return () => {
    gauge.removeCallback(callback);
  };
}
