import { claimDueOrders, createOrder, type ClaimedOrder, type PaymentMethod } from '@commerce/db';
import { currentTraceparent, traceLogMixin, withSpan } from '@commerce/telemetry';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ageClaim,
  createTestPool,
  insertProducts,
  makeDue,
  orderState,
  placeOrder,
  resetDatabase,
} from '../../../packages/db/test/support.js';
import type { Limits } from '../src/lifecycle.js';
import { runWorkerLoop } from '../src/loop.js';
import type { PaymentProvider } from '../src/payment/provider.js';
import { createClaimRecoverer } from '../src/recovery.js';
import { createClaimReleaser, shutdownWorker } from '../src/shutdown.js';
import {
  claimOne,
  FakeProvider,
  limits,
  makeWorker,
  realSimulator,
  runPasses,
  silentLogger,
  timeoutError,
  waitUntil,
} from './support.js';

const HOUR = 3_600_000;
const SKU = 'SKU-00001';
const POLICY = { maxReconciliationAttempts: 5, paymentUnknownRecheckMs: 900_000 };

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const pool = createTestPool();
const simulatorPool = createTestPool();

beforeAll(() => {
  provider.register();
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  await pool.end();
  await simulatorPool.end();
});
beforeEach(async () => {
  exporter.reset();
  await resetDatabase(pool);
  await insertProducts(pool, [{ sku: SKU, priceCents: 1000, stock: 50 }]);
});

/** A logger that keeps lines and adds trace ids, like the apps' loggers. */
function tracedLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'debug', mixin: traceLogMixin },
    { write: (l: string) => lines.push(JSON.parse(l) as Record<string, unknown>) },
  );
  return { logger, lines };
}

/** Creates an order inside a creation span, storing its traceparent as the API does. */
async function placeTracedOrder(method: PaymentMethod = 'pm_card_ok') {
  return withSpan('order.create', {}, async (span) => {
    const result = await createOrder(
      pool,
      {
        items: [{ sku: SKU, quantity: 1 }],
        paymentMethod: method,
        idempotencyKey: null,
        requestHash: 'test',
        traceContext: currentTraceparent(),
      },
      (lines) => lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0),
    );
    if (result.kind !== 'created') throw new Error(result.kind);
    return { id: result.order.id, creation: span.spanContext() };
  });
}

const spansNamed = (name: string): ReadableSpan[] =>
  exporter.getFinishedSpans().filter((s) => s.name === name);
const childrenOf = (parent: ReadableSpan): ReadableSpan[] =>
  exporter
    .getFinishedSpans()
    .filter((s) => s.parentSpanContext?.spanId === parent.spanContext().spanId);

describe('each pass is its own trace (criterion 8)', () => {
  function expectPassSpan(
    pass: ReadableSpan | undefined,
    orderId: string,
    creationTraceId: string,
  ) {
    expect(pass).toBeDefined();
    if (!pass) return;
    expect(pass.parentSpanContext).toBeUndefined();
    expect(pass.kind).toBe(SpanKind.CONSUMER);
    expect(pass.spanContext().traceId).not.toBe(creationTraceId);
    expect(pass.attributes['order.id']).toBe(orderId);
    expect(pass.links).toHaveLength(1);
    expect(pass.links[0]?.context.traceId).toBe(creationTraceId);
    expect(pass.links[0]?.attributes).toEqual({ 'order.link': 'created', 'order.id': orderId });
  }

  it('charge pass: root span with pass attributes and charge, reserve and finalize children', async () => {
    const { id, creation } = await placeTracedOrder();
    const sim = realSimulator(simulatorPool);
    const { processor } = makeWorker(pool, sim.provider);

    expect(await runPasses(pool, processor)).toEqual(['paid']);

    const [pass] = spansNamed('order.process');
    expectPassSpan(pass, id, creation.traceId);
    expect(pass?.attributes).toMatchObject({
      'order.pass.type': 'charge',
      'order.processing_attempt': 1,
      'order.charge_attempts': 0,
      'order.reconciliation_attempts': 0,
      'order.pass.outcome': 'paid',
    });
    expect(pass?.attributes).not.toHaveProperty('order.trace_context_missing');
    const children = pass ? childrenOf(pass) : [];
    expect(children.map((c) => c.name)).toEqual([
      'order.reserve',
      'payment.charge',
      'order.finalize',
    ]);
    const charge = children.find((c) => c.name === 'payment.charge');
    expect(charge?.attributes).toEqual({ 'payment.result': 'approved', 'payment.replayed': false });
    const reference = (await orderState(pool, id)).payment_reference ?? 'none';
    const everything = JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes));
    expect(everything).not.toContain(reference);
    expect(children.find((c) => c.name === 'order.finalize')?.attributes).toEqual({
      'order.finalize.target': 'paid',
      'order.inventory_released': false,
    });
  });

  it('retry, reconciliation and payment_unknown recheck passes each get a new linked trace', async () => {
    const { id, creation } = await placeTracedOrder();
    const fake = new FakeProvider();
    fake.onCharge = () => Promise.reject(timeoutError());
    const lim: Limits = limits({ maxChargeAttempts: 2, maxReconciliationAttempts: 2 });
    const { processor } = makeWorker(pool, fake, { limits: lim });

    // 1: charge pass, unknown outcome, retry scheduled.
    expect(await runPasses(pool, processor)).toEqual(['retry_scheduled']);
    // 2: charge pass on the last attempt, then reconciliation in the same pass; lookup fails.
    await makeDue(pool, id);
    expect(await runPasses(pool, processor)).toEqual(['reconciliation_retry']);
    // 3: reconciliation pass; lookup fails again and the order is parked.
    await makeDue(pool, id);
    expect(await runPasses(pool, processor)).toEqual(['parked']);
    // 4: payment_unknown recheck; the lookup now finds an approval.
    fake.onLookup = () =>
      Promise.resolve({ outcome: 'approved', reference: 'ref-r', replayed: true });
    await makeDue(pool, id);
    expect(await runPasses(pool, processor)).toEqual(['paid']);

    const passes = spansNamed('order.process').sort(
      (a, b) =>
        (a.attributes['order.processing_attempt'] as number) -
        (b.attributes['order.processing_attempt'] as number),
    );
    expect(
      passes.map((p) => [p.attributes['order.pass.type'], p.attributes['order.pass.outcome']]),
    ).toEqual([
      ['charge', 'retry_scheduled'],
      ['charge', 'reconciliation_retry'],
      ['reconciliation', 'parked'],
      ['reconciliation', 'paid'],
    ]);
    for (const pass of passes) expectPassSpan(pass, id, creation.traceId);
    expect(new Set(passes.map((p) => p.spanContext().traceId)).size).toBe(4);

    const [first, second, third, fourth] = passes.map((p) => childrenOf(p));
    expect(first?.find((c) => c.name === 'payment.charge')?.attributes).toEqual({
      'payment.result': 'error',
    });
    expect(passes[0]?.events.map((e) => [e.name, e.attributes])).toEqual([
      ['payment.outcome_unknown', { 'payment.operation': 'charge' }],
    ]);
    expect(second?.map((c) => c.name)).toEqual([
      'order.reserve',
      'payment.charge',
      'payment.lookup_or_void',
      'order.finalize',
    ]);
    expect(third?.map((c) => c.name)).toEqual(['payment.lookup_or_void', 'order.finalize']);
    expect(fourth?.find((c) => c.name === 'payment.lookup_or_void')?.attributes).toEqual({
      'payment.result': 'approved',
      'payment.replayed': true,
    });
    expect(passes[2]?.attributes['order.reconciliation_attempts']).toBe(1);
    expect(passes[3]?.attributes['order.reconciliation_attempts']).toBe(2);
    expect(passes.every((p) => p.status.code !== SpanStatusCode.ERROR)).toBe(true);
  });
});

describe('order.inventory_released on order.finalize', () => {
  const finalizeOf = (orderId: string): ReadableSpan | undefined => {
    const pass = spansNamed('order.process').find((p) => p.attributes['order.id'] === orderId);
    return pass ? childrenOf(pass).find((c) => c.name === 'order.finalize') : undefined;
  };
  const releasedAt = async (orderId: string) =>
    (await orderState(pool, orderId)).inventory_released_at;

  it('is true when a declined order releases the stock it reserved in this pass', async () => {
    const { id } = await placeTracedOrder('pm_card_declined');
    const { processor } = makeWorker(pool, realSimulator(simulatorPool).provider);

    expect(await runPasses(pool, processor)).toEqual(['failed']);

    expect(finalizeOf(id)?.attributes).toEqual({
      'order.finalize.target': 'failed',
      'order.inventory_released': true,
    });
    expect(await releasedAt(id)).toBeInstanceOf(Date);
  });

  it('is true when the stock was reserved by an earlier pass', async () => {
    const { id } = await placeTracedOrder();
    const fake = new FakeProvider();
    fake.onCharge = () => Promise.reject(timeoutError());
    const { processor } = makeWorker(pool, fake, { limits: limits({ maxChargeAttempts: 2 }) });
    expect(await runPasses(pool, processor)).toEqual(['retry_scheduled']);
    exporter.reset();
    fake.onCharge = () =>
      Promise.resolve({ outcome: 'declined', reference: 'ref-d', replayed: false });
    await makeDue(pool, id);

    expect(await runPasses(pool, processor)).toEqual(['failed']);

    expect(finalizeOf(id)?.attributes['order.inventory_released']).toBe(true);
    expect(await releasedAt(id)).toBeInstanceOf(Date);
  });

  it('is false when an order that never reserved stock is voided and failed', async () => {
    const { id } = await placeTracedOrder();
    // Past the claim ceiling without ever reserving: the next pass only reconciles.
    await pool.query('UPDATE orders SET processing_attempts = 2 WHERE id = $1', [id]);
    const { processor } = makeWorker(pool, realSimulator(simulatorPool).provider, {
      limits: limits({ maxClaims: 2, maxChargeAttempts: 1 }),
    });

    expect(await runPasses(pool, processor)).toEqual(['failed']);

    expect(finalizeOf(id)?.attributes).toEqual({
      'order.finalize.target': 'failed',
      'order.inventory_released': false,
    });
    expect(await releasedAt(id)).toBeNull();
  });

  it('records no finalize span for out_of_stock, which fails before reserving anything', async () => {
    await pool.query('UPDATE products SET stock_available = 0 WHERE sku = $1', [SKU]);
    const { id } = await placeTracedOrder();
    const { processor } = makeWorker(pool, realSimulator(simulatorPool).provider);

    expect(await runPasses(pool, processor)).toEqual(['failed']);

    expect(finalizeOf(id)).toBeUndefined();
    expect(await orderState(pool, id)).toMatchObject({
      failure_reason: 'out_of_stock',
      inventory_reserved_at: null,
      inventory_released_at: null,
    });
  });
});

describe('missing creation context (criterion 10)', () => {
  it('processes exactly as in M2, with no link and order.trace_context_missing', async () => {
    const id = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]);
    expect(
      (await pool.query('SELECT trace_context FROM orders WHERE id = $1', [id])).rows[0],
    ).toEqual({
      trace_context: null,
    });
    const { processor } = makeWorker(pool, realSimulator(simulatorPool).provider);

    expect(await runPasses(pool, processor)).toEqual(['paid']);

    const [pass] = spansNamed('order.process');
    expect(pass?.links).toEqual([]);
    expect(pass?.attributes).toMatchObject({ 'order.id': id, 'order.trace_context_missing': true });
    expect((await orderState(pool, id)).status).toBe('paid');
  });
});

describe('recovery and release spans (criterion 9)', () => {
  it('records one sweep span with a linked child and a correlated log line per recovered order', async () => {
    const a = await placeTracedOrder();
    const bId = await placeOrder(pool, [{ sku: SKU, quantity: 1 }]); // no stored context
    await claimOne(pool, 'crashed');
    await claimOne(pool, 'crashed');
    await ageClaim(pool, a.id);
    await ageClaim(pool, bId);
    exporter.reset();
    const { logger, lines } = tracedLogger();
    const recover = createClaimRecoverer({
      pool,
      logger,
      params: { ...POLICY, claimTimeoutMs: 60_000, retryBaseMs: 1000, retryMaxMs: 30_000 },
    });

    expect(await recover()).toBe(2);

    const [sweep] = spansNamed('worker.recover_claims');
    expect(spansNamed('worker.recover_claims')).toHaveLength(1);
    expect(sweep?.parentSpanContext).toBeUndefined();
    expect(sweep?.attributes).toEqual({ 'claims.recovered': 2 });
    const children = spansNamed('order.claim_recovered');
    expect(children).toHaveLength(2);
    const childA = children.find((c) => c.attributes['order.id'] === a.id);
    const childB = children.find((c) => c.attributes['order.id'] === bId);
    expect(childA?.links[0]?.context.traceId).toBe(a.creation.traceId);
    expect(childA?.attributes).toMatchObject({
      'order.status': 'pending',
      'order.processing_attempt': 1,
    });
    expect(childB?.links).toEqual([]);
    expect(childB?.attributes['order.trace_context_missing']).toBe(true);
    for (const child of children)
      expect(child.parentSpanContext?.spanId).toBe(sweep?.spanContext().spanId);

    const logged = lines.filter((l) => l.msg === 'claim_recovered');
    expect(logged).toHaveLength(2);
    for (const line of logged) {
      const child = children.find((c) => c.attributes['order.id'] === line.orderId);
      expect(line.trace_id).toBe(sweep?.spanContext().traceId);
      expect(line.span_id).toBe(child?.spanContext().spanId);
    }

    exporter.reset();
    expect(await recover()).toBe(0);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  /** A real loop whose releaser reads trace contexts from the registry, as main.ts wires it. */
  function startWorker(provider_: PaymentProvider, logger = silentLogger) {
    const { processor, registry } = makeWorker(pool, provider_);
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
    return {
      registry,
      shutdown: () =>
        shutdownWorker({
          stopLoop: () => {
            controller.abort();
          },
          loopDone,
          registry,
          drainDeadline: Promise.resolve(),
          release: createClaimReleaser(
            pool,
            POLICY,
            logger,
            (id) => registry.get(id)?.order.traceContext ?? null,
          ),
          logger: silentLogger,
        }),
    };
  }

  it('records a release span with linked children for released and unconfirmed orders', async () => {
    const released = await placeTracedOrder();
    const held = await placeTracedOrder();
    const fake = new FakeProvider();
    fake.blockCharges();
    const { logger, lines } = tracedLogger();
    const worker = startWorker(fake, logger);
    await waitUntil(() => fake.charges.length === 2, 'both charges started');

    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [held.id]);
    let result;
    try {
      result = await worker.shutdown();
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    // The shutdown result is exactly M2's.
    expect(result).toEqual({
      exitCode: 1,
      drained: false,
      released: [released.id],
      unconfirmed: [held.id],
    });
    const [sweep] = spansNamed('worker.release_claims');
    expect(sweep?.attributes).toEqual({ 'release.released': 1, 'release.unconfirmed': 1 });
    const children = spansNamed('order.claim_released');
    const childReleased = children.find((c) => c.attributes['order.id'] === released.id);
    const childHeld = children.find((c) => c.attributes['order.id'] === held.id);
    expect(childReleased?.attributes['release.result']).toBe('released');
    expect(childReleased?.links[0]?.context.traceId).toBe(released.creation.traceId);
    expect(childHeld?.attributes['release.result']).toBe('unconfirmed');
    expect(childHeld?.links[0]?.context.traceId).toBe(held.creation.traceId);
    const logged = lines.filter((l) => l.msg === 'claim_released');
    expect(logged.map((l) => [l.orderId, l.trace_id])).toEqual(
      expect.arrayContaining([
        [released.id, sweep?.spanContext().traceId],
        [held.id, sweep?.spanContext().traceId],
      ]),
    );
  });

  it('keeps the M2 releaser result and records nothing when no lookup is given', async () => {
    await placeTracedOrder();
    const fake = new FakeProvider();
    fake.blockCharges();
    const { processor, registry } = makeWorker(pool, fake);
    const order = await claimOne(pool);
    void processor.process(order);
    await waitUntil(() => fake.charges.length === 1, 'charge started');
    exporter.reset();
    registry.get(order.id)?.abort();
    const release = createClaimReleaser(pool, POLICY, silentLogger);
    expect(await release([{ orderId: order.id, token: order.processingAttempts }])).toEqual({
      released: [order.id],
      unconfirmed: [],
    });
    expect(spansNamed('worker.release_claims')).toEqual([]);
  });
});

describe('no context leakage between concurrent passes (criterion 11)', () => {
  it('keeps two concurrent passes in separate traces, with their own children and logs', async () => {
    const a = await placeTracedOrder();
    const b = await placeTracedOrder();
    const fake = new FakeProvider();
    fake.blockCharges();
    const { logger, lines } = tracedLogger();
    const { processor } = makeWorker(pool, fake, { logger });
    const activeDuringLoop: boolean[] = [];
    const controller = new AbortController();
    const loopDone = runWorkerLoop<ClaimedOrder>(
      {
        claim: (limit) => {
          activeDuringLoop.push(trace.getActiveSpan() !== undefined);
          return claimDueOrders(pool, { workerId: 'w1', limit });
        },
        recover: () => {
          activeDuringLoop.push(trace.getActiveSpan() !== undefined);
          return Promise.resolve();
        },
        process: (order) => processor.process(order),
        concurrency: 2,
        claimBatchSize: 10,
        pollIntervalMs: 20,
        logger: silentLogger,
      },
      controller.signal,
    );
    await waitUntil(() => fake.charges.length === 2, 'both passes blocked in charge');
    // The loop keeps polling while both passes are open.
    const pollsBefore = activeDuringLoop.length;
    await waitUntil(() => activeDuringLoop.length > pollsBefore + 2, 'loop polled during passes');
    fake.release(b.id, { outcome: 'approved', reference: 'ref-b', replayed: false });
    fake.release(a.id, { outcome: 'approved', reference: 'ref-a', replayed: false });
    await waitUntil(
      async () =>
        (await orderState(pool, a.id)).status === 'paid' &&
        (await orderState(pool, b.id)).status === 'paid',
      'both paid',
    );
    controller.abort();
    await loopDone;

    const passes = spansNamed('order.process');
    expect(passes).toHaveLength(2);
    const passOf = (id: string) => passes.find((p) => p.attributes['order.id'] === id);
    const traceA = passOf(a.id)?.spanContext().traceId;
    const traceB = passOf(b.id)?.spanContext().traceId;
    expect(traceA).toBeDefined();
    expect(traceA).not.toBe(traceB);

    const all = exporter.getFinishedSpans();
    const byId = new Map(all.map((s) => [s.spanContext().spanId, s]));
    const workerSpans = all.filter((s) => [traceA, traceB].includes(s.spanContext().traceId));
    for (const span of workerSpans) {
      const parent = span.parentSpanContext ? byId.get(span.parentSpanContext.spanId) : undefined;
      if (span.parentSpanContext)
        expect(parent?.spanContext().traceId).toBe(span.spanContext().traceId);
    }
    expect(
      workerSpans.filter((s) => s.spanContext().traceId === traceA && s.name === 'payment.charge'),
    ).toHaveLength(1);
    expect(
      workerSpans.filter((s) => s.spanContext().traceId === traceB && s.name === 'payment.charge'),
    ).toHaveLength(1);

    const passLogs = lines.filter((l) => l.orderId === a.id || l.orderId === b.id);
    expect(passLogs.length).toBeGreaterThan(0);
    for (const line of passLogs) {
      expect(line.trace_id).toBe(line.orderId === a.id ? traceA : traceB);
    }
    expect(activeDuringLoop.length).toBeGreaterThan(3);
    expect(activeDuringLoop.every((active) => !active)).toBe(true);
  });
});
