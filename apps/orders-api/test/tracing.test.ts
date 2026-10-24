import { seedCatalog, seedProduct } from '@commerce/db';
import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, resetDatabase } from '../../../packages/db/test/support.js';
import { buildServer } from '../src/server.js';

/** Criterion 7: the order-creation trace context is stored, and order.id is on the spans. */
describe('order creation tracing (criterion 7)', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const pool = createTestPool();
  const app = buildServer({ pool, logger: pino({ level: 'silent' }) });
  const body = { items: [{ sku: seedProduct(42).sku, quantity: 1 }], paymentMethod: 'pm_card_ok' };

  beforeAll(async () => {
    provider.register();
    await resetDatabase(pool);
    await seedCatalog(pool);
  });
  beforeEach(async () => {
    exporter.reset();
    await pool.query('TRUNCATE payment_charges, order_items, orders');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  /** Stands in for the HTTP server span that instrumentation-http creates in production. */
  const postUnderServerSpan = (headers: Record<string, string> = {}) =>
    trace.getTracer('test').startActiveSpan('POST /orders', (server) =>
      app.inject({ method: 'POST', url: '/orders', payload: body, headers }).finally(() => {
        server.end();
      }),
    );

  async function storedTraceContext(id: string): Promise<string | null> {
    const r = await pool.query<{ trace_context: string | null }>(
      'SELECT trace_context FROM orders WHERE id = $1',
      [id],
    );
    return r.rows[0]?.trace_context ?? null;
  }

  it('stores the order.create span context and puts order.id on it and on the server span', async () => {
    const res = await postUnderServerSpan();
    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();

    const spans = exporter.getFinishedSpans();
    const server = spans.find((s) => s.name === 'POST /orders');
    const create = spans.find((s) => s.name === 'order.create');
    expect(create?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
    expect(create?.attributes).toEqual({ 'order.id': id, 'order.idempotent_replay': false });
    expect(server?.attributes['order.id']).toBe(id);
    const ctx = create?.spanContext();
    expect(await storedTraceContext(id)).toBe(`00-${ctx?.traceId}-${ctx?.spanId}-01`);
    expect(res.json()).not.toHaveProperty('traceContext');
  });

  it('keeps the originally stored context on an idempotent replay', async () => {
    const first = await postUnderServerSpan({ 'idempotency-key': 'trace-1' });
    const { id } = first.json<{ id: string }>();
    const original = await storedTraceContext(id);
    exporter.reset();

    const replay = await postUnderServerSpan({ 'idempotency-key': 'trace-1' });
    expect(replay.statusCode).toBe(200);
    const create = exporter.getFinishedSpans().find((s) => s.name === 'order.create');
    expect(create?.attributes).toEqual({ 'order.id': id, 'order.idempotent_replay': true });
    expect(create?.spanContext().traceId).not.toBe(original?.split('-')[1]);
    expect(await storedTraceContext(id)).toBe(original);
  });

  it('stores null when no span is active, and puts no order.id on failed requests', async () => {
    trace.disable();
    const untraced = await app.inject({ method: 'POST', url: '/orders', payload: body });
    expect(await storedTraceContext(untraced.json<{ id: string }>().id)).toBeNull();
    provider.register();

    exporter.reset();
    const unknown = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { items: [{ sku: 'SKU-99999', quantity: 1 }], paymentMethod: 'pm_card_ok' },
    });
    expect(unknown.statusCode).toBe(422);
    const create = exporter.getFinishedSpans().find((s) => s.name === 'order.create');
    expect(create?.attributes).toEqual({});
  });
});
