import { claimDueOrders, type ClaimedOrder } from '@commerce/db';
import { completeShutdown, createWorkerMetrics, type TelemetryHandle } from '@commerce/telemetry';
import { context, trace } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestPool,
  insertProducts,
  ledgerRows,
  orderState,
  placeOrder,
  resetDatabase,
  stockOf,
} from '../../../packages/db/test/support.js';
import { runWorkerLoop } from '../src/loop.js';
import type { PaymentProvider } from '../src/payment/provider.js';
import { createClaimReleaser, shutdownWorker } from '../src/shutdown.js';
import {
  Deferred,
  FakeProvider,
  makeWorker,
  realSimulator,
  silentLogger,
  waitUntil,
} from './support.js';

/**
 * Criterion 17: M2's shutdown scenarios 23, 24 and 35, re-run while every span and metric export
 * hangs.
 * The M2 tests themselves are unchanged; this proves telemetry cannot hold up order processing,
 * the shutdown protocol, or the exit code.
 */
class HangingExporter implements SpanExporter {
  exports = 0;
  // Accepts every batch and never calls back, so each export hangs until its timeout.
  export(): void {
    this.exports += 1;
  }
  shutdown(): Promise<void> {
    return new Promise(() => undefined);
  }
  forceFlush(): Promise<void> {
    return new Promise(() => undefined);
  }
}

/** M3c: the metric exporter hangs the same way. */
class HangingMetricExporter implements PushMetricExporter {
  exports = 0;
  export(): void {
    this.exports += 1;
  }
  shutdown(): Promise<void> {
    return new Promise(() => undefined);
  }
  forceFlush(): Promise<void> {
    return new Promise(() => undefined);
  }
}

const HOUR = 3_600_000;
const SKU = 'SKU-00001';
const POLICY = { maxReconciliationAttempts: 5, paymentUnknownRecheckMs: 900_000 };
const exporter = new HangingExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [
    new BatchSpanProcessor(exporter, { scheduledDelayMillis: 10, exportTimeoutMillis: HOUR }),
  ],
});
const metricExporter = new HangingMetricExporter();
// The periodic timer never fires during a test; only the shutdown flush exports, and it hangs.
const meterProvider = new MeterProvider({
  readers: [
    new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: HOUR,
      exportTimeoutMillis: HOUR,
    }),
  ],
});
const workerMetrics = createWorkerMetrics(meterProvider.getMeter('test'));
const telemetry: TelemetryHandle = {
  enabled: true,
  metricsSampleIntervalMs: 5000,
  forceFlush: async () => {
    await Promise.all([provider.forceFlush(), meterProvider.forceFlush()]);
  },
  shutdown: async () => {
    await Promise.all([provider.shutdown(), meterProvider.shutdown()]);
  },
};

const pool = createTestPool();
const simulatorPool = createTestPool();
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown): void => {
  unhandled.push(e);
};

beforeAll(() => {
  provider.register();
  process.on('unhandledRejection', onUnhandled);
});
afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  trace.disable();
  context.disable();
  await pool.end();
  await simulatorPool.end();
});
beforeEach(async () => {
  await resetDatabase(pool);
  await insertProducts(pool, [{ sku: SKU, priceCents: 1000, stock: 10 }]);
});

function startTracedWorker(provider_: PaymentProvider) {
  const { processor, registry } = makeWorker(pool, provider_, { metrics: workerMetrics });
  const tracer = trace.getTracer('test');
  const controller = new AbortController();
  const loopDone = runWorkerLoop<ClaimedOrder>(
    {
      claim: (limit) => claimDueOrders(pool, { workerId: 'w1', limit }),
      recover: () => Promise.resolve(),
      // Every pass runs inside a span, so every pass produces spans for the hanging exporter.
      process: (order) =>
        tracer.startActiveSpan('order.process', { root: true }, (span) =>
          processor.process(order).finally(() => {
            span.end();
          }),
        ),
      concurrency: 2,
      claimBatchSize: 10,
      pollIntervalMs: HOUR,
      logger: silentLogger,
    },
    controller.signal,
  );
  return {
    registry,
    loopDone,
    shutdown: (drainDeadline: Promise<void>) =>
      shutdownWorker({
        stopLoop: () => {
          controller.abort();
        },
        loopDone,
        registry,
        drainDeadline,
        release: createClaimReleaser(pool, POLICY, silentLogger, undefined, workerMetrics),
        logger: silentLogger,
      }),
  };
}

/** The worker's final step, as in main.ts, with the hanging telemetry handle. */
async function finish(exitCode: number): Promise<{ exitCodes: number[]; flush: string }> {
  const exitCodes: number[] = [];
  let flush = '';
  // Guarantee a span is still buffered when the flush starts, so the flush must call the hanging
  // exporter. Without this, the 10 ms batch timer may already have handed every span to the
  // (hanging) exporter, and flushing an empty buffer correctly reports "flushed". The flush runs
  // in microtasks right after this line, before any timer can fire.
  trace.getTracer('test').startSpan('pre-shutdown').end();
  await completeShutdown({
    exitCode,
    cleanup: () => Promise.resolve(),
    telemetry,
    deadlineAt: Date.now() + 8000,
    exit: (code) => exitCodes.push(code),
    onFlush: (result) => {
      flush = result;
    },
  });
  return { exitCodes, flush };
}

describe('shutdown with hanging span and metric exporters (criterion 17)', () => {
  it('drains an in-flight order exactly as M2 criterion 23, then exits 0', async () => {
    const a = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const fake = new FakeProvider();
    fake.blockCharges();
    const sim = realSimulator(simulatorPool);
    const worker = startTracedWorker(fake);
    await waitUntil(() => fake.charges.length === 1, 'charge started');

    const deadline = new Deferred<void>();
    const done = worker.shutdown(deadline.promise);
    await worker.loopDone;
    const request = fake.charges[0];
    if (!request) throw new Error('no charge');
    fake.release(a, await sim.provider.charge(request));
    const result = await done;

    expect(result).toEqual({ exitCode: 0, drained: true, released: [], unconfirmed: [] });
    expect((await orderState(pool, a)).status).toBe('paid');
    expect(await finish(result.exitCode)).toEqual({ exitCodes: [0], flush: 'timed_out' });
    expect(exporter.exports).toBeGreaterThan(0);
    expect(metricExporter.exports).toBeGreaterThan(0);
  });

  it('releases a charge recorded just before shutdown exactly as M2 criterion 24', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 2 }]);
    const sim = realSimulator(simulatorPool);
    const fake = new FakeProvider();
    fake.onCharge = async (request) => {
      await sim.provider.charge(request);
      return new Promise(() => undefined);
    };
    const worker = startTracedWorker(fake);
    await waitUntil(async () => (await ledgerRows(pool, id)).length === 1, 'approval recorded');

    const result = await worker.shutdown(Promise.resolve());

    expect(result).toEqual({ exitCode: 0, drained: false, released: [id], unconfirmed: [] });
    expect(await orderState(pool, id)).toMatchObject({
      status: 'pending',
      last_error: 'released_on_shutdown',
      charge_attempts: 1,
      inventory_released_at: null,
    });
    expect(await stockOf(pool, SKU)).toBe(8);
    expect(await finish(result.exitCode)).toEqual({ exitCodes: [0], flush: 'timed_out' });
  });

  it('reports an unconfirmed release exactly as M2 criterion 35, then exits 1', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 3 }]);
    const fake = new FakeProvider();
    fake.blockCharges();
    const worker = startTracedWorker(fake);
    await waitUntil(() => fake.charges.length === 1, 'charge started');

    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [id]);
    let result;
    try {
      result = await worker.shutdown(Promise.resolve());
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    expect(result).toEqual({ exitCode: 1, drained: false, released: [], unconfirmed: [id] });
    expect((await orderState(pool, id)).status).toBe('processing');
    expect(await finish(result.exitCode)).toEqual({ exitCodes: [1], flush: 'timed_out' });
    expect(unhandled).toEqual([]);
  });
});
