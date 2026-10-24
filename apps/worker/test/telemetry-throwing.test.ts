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
  orderState,
  placeOrder,
  resetDatabase,
  stockOf,
} from '../../../packages/db/test/support.js';
import { runWorkerLoop } from '../src/loop.js';
import { createClaimReleaser, shutdownWorker } from '../src/shutdown.js';
import { makeWorker, realSimulator, runPasses, silentLogger, waitUntil } from './support.js';

/**
 * Criterion 16 [D], the throwing half: every span and metric export throws synchronously, and
 * flush and shutdown reject. Order and pass outcomes, the shutdown protocol and the exit code must
 * be exactly M2's, with no unhandled rejection. The never-settling half is
 * telemetry-shutdown.test.ts, which stays unchanged in purpose.
 */
class ThrowingSpanExporter implements SpanExporter {
  exports = 0;
  export(): void {
    this.exports += 1;
    throw new Error('span export exploded');
  }
  shutdown(): Promise<void> {
    return Promise.reject(new Error('span exporter shutdown exploded'));
  }
  forceFlush(): Promise<void> {
    return Promise.reject(new Error('span exporter flush exploded'));
  }
}

class ThrowingMetricExporter implements PushMetricExporter {
  exports = 0;
  export(): void {
    this.exports += 1;
    throw new Error('metric export exploded');
  }
  shutdown(): Promise<void> {
    return Promise.reject(new Error('metric exporter shutdown exploded'));
  }
  forceFlush(): Promise<void> {
    return Promise.reject(new Error('metric exporter flush exploded'));
  }
}

const HOUR = 3_600_000;
const SKU = 'SKU-00001';
const POLICY = { maxReconciliationAttempts: 5, paymentUnknownRecheckMs: 900_000 };
const spanExporter = new ThrowingSpanExporter();
const metricExporter = new ThrowingMetricExporter();
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [
    new BatchSpanProcessor(spanExporter, { scheduledDelayMillis: 10, exportTimeoutMillis: HOUR }),
  ],
});
// The periodic timer never fires during a test; the shutdown flush is the only metric export.
const meterProvider = new MeterProvider({
  readers: [
    new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: HOUR,
      exportTimeoutMillis: HOUR,
    }),
  ],
});
const metrics = createWorkerMetrics(meterProvider.getMeter('test'));
const telemetry: TelemetryHandle = {
  enabled: true,
  metricsSampleIntervalMs: 5000,
  forceFlush: async () => {
    await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
  },
  shutdown: async () => {
    await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  },
};

const pool = createTestPool();
const simulatorPool = createTestPool();
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown): void => {
  unhandled.push(e);
};

beforeAll(() => {
  tracerProvider.register();
  process.on('unhandledRejection', onUnhandled);
});
afterAll(async () => {
  // Let any late rejection surface before the listener is removed.
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
  trace.disable();
  context.disable();
  await pool.end();
  await simulatorPool.end();
});
beforeEach(async () => {
  await resetDatabase(pool);
  await insertProducts(pool, [{ sku: SKU, priceCents: 1000, stock: 10 }]);
});

/** The worker's final step, as in main.ts, with the throwing telemetry handle. */
async function finish(exitCode: number): Promise<{ exitCodes: number[]; flush: string }> {
  const exitCodes: number[] = [];
  let flush = '';
  // A buffered span, so the trace flush calls the throwing exporter (see the hanging test).
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

describe('telemetry with throwing exporters (criterion 16)', () => {
  it('paid and declined passes keep their M2 outcomes, and the flush fails without changing exit 0', async () => {
    const ok = await placeOrder(pool, [{ sku: SKU, quantity: 2 }], 'pm_card_ok');
    const declined = await placeOrder(pool, [{ sku: SKU, quantity: 3 }], 'pm_card_declined');
    const { processor } = makeWorker(pool, realSimulator(simulatorPool).provider, { metrics });

    expect((await runPasses(pool, processor)).sort()).toEqual(['failed', 'paid']);
    expect(await orderState(pool, ok)).toMatchObject({ status: 'paid', failure_reason: null });
    expect(await orderState(pool, declined)).toMatchObject({
      status: 'failed',
      failure_reason: 'payment_declined',
    });
    // The paid order's 2 units stay reserved; the declined order's 3 are released.
    expect(await stockOf(pool, SKU)).toBe(8);

    expect(await finish(0)).toEqual({ exitCodes: [0], flush: 'failed' });
    expect(spanExporter.exports).toBeGreaterThan(0);
    expect(metricExporter.exports).toBeGreaterThan(0);
  });

  it('a drain shutdown returns M2 criterion 23 results, and exit code 1 passes through unchanged', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    const { processor, registry } = makeWorker(pool, realSimulator(simulatorPool).provider, {
      metrics,
    });
    const controller = new AbortController();
    const loopDone = runWorkerLoop<ClaimedOrder>(
      {
        claim: (limit) => claimDueOrders(pool, { workerId: 'w1', limit }),
        recover: () => Promise.resolve(),
        process: (order) => processor.process(order),
        concurrency: 2,
        claimBatchSize: 10,
        pollIntervalMs: HOUR,
        logger: silentLogger,
      },
      controller.signal,
    );
    // The loop claims and pays the order while every span export throws.
    await waitUntil(async () => (await orderState(pool, id)).status === 'paid', 'order paid');
    await registry.whenIdle();
    const result = await shutdownWorker({
      stopLoop: () => {
        controller.abort();
      },
      loopDone,
      registry,
      drainDeadline: new Promise(() => undefined),
      release: createClaimReleaser(pool, POLICY, silentLogger, undefined, metrics),
      logger: silentLogger,
    });
    expect(result).toEqual({ exitCode: 0, drained: true, released: [], unconfirmed: [] });
    expect(await finish(result.exitCode)).toEqual({ exitCodes: [0], flush: 'failed' });
    // An exit code the M2 protocol decided as 1 is never changed by a failing flush.
    expect(await finish(1)).toEqual({ exitCodes: [1], flush: 'failed' });
  });
});
