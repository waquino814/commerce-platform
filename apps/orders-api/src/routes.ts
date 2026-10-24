import { createHash } from 'node:crypto';
import { createOrder, getOrder, listProducts, type OrderView, type Pool } from '@commerce/db';
import { annotateActiveSpan, currentTraceparent, withSpan } from '@commerce/telemetry';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendError, sendValidationError } from './errors.js';
import { orderTotalCents } from './pricing.js';

export const PAYMENT_METHODS = ['pm_card_ok', 'pm_card_declined', 'pm_card_unavailable'] as const;

const skuSchema = z.string().regex(/^SKU-\d{5}$/, 'must look like SKU-00042');

export const listProductsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: skuSchema.optional(),
});

export const createOrderBody = z.strictObject({
  items: z
    .array(z.strictObject({ sku: skuSchema, quantity: z.number().int().min(1).max(100) }))
    .min(1)
    .max(50)
    .refine((items) => new Set(items.map((i) => i.sku)).size === items.length, {
      message: 'SKUs must be unique',
    }),
  paymentMethod: z.enum(PAYMENT_METHODS),
});

export const idempotencyKeySchema = z
  .string()
  .regex(/^[\x21-\x7E]{1,128}$/, 'must be 1 to 128 visible ASCII characters');

const orderParams = z.strictObject({ id: z.uuid() });

/** JSON response shape: timestamps as ISO 8601 strings, money as integer cents. */
export function orderResponse(order: OrderView): Record<string, unknown> {
  return {
    ...order,
    nextAttemptAt: order.nextAttemptAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    failedAt: order.failedAt?.toISOString() ?? null,
  };
}

/** Stable hash of the parsed request, used to detect idempotency-key reuse with another body. */
function requestHash(body: z.infer<typeof createOrderBody>): string {
  return createHash('sha256')
    .update(JSON.stringify({ items: body.items, paymentMethod: body.paymentMethod }))
    .digest('hex');
}

export function registerCommerceRoutes(app: FastifyInstance, deps: { pool: Pool }): void {
  app.get('/products', async (request, reply) => {
    const query = listProductsQuery.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error);
    return listProducts(deps.pool, { limit: query.data.limit, after: query.data.after ?? null });
  });

  app.post('/orders', async (request, reply) => {
    const body = createOrderBody.safeParse(request.body);
    if (!body.success) return sendValidationError(reply, body.error);

    const rawKey = request.headers['idempotency-key'];
    let idempotencyKey: string | null = null;
    if (rawKey !== undefined) {
      const key = idempotencyKeySchema.safeParse(rawKey);
      if (!key.success) return sendValidationError(reply, key.error);
      idempotencyKey = key.data;
    }

    // M3b: the order.create span's traceparent is stored with a new order, so every later worker
    // pass can link back to this trace. A replay keeps the originally stored value.
    const result = await withSpan('order.create', {}, async (span) => {
      const created = await createOrder(
        deps.pool,
        {
          items: body.data.items,
          paymentMethod: body.data.paymentMethod,
          idempotencyKey,
          requestHash: requestHash(body.data),
          traceContext: currentTraceparent(),
        },
        orderTotalCents,
      );
      if (created.kind === 'created' || created.kind === 'replayed') {
        span.setAttributes({
          'order.id': created.order.id,
          'order.idempotent_replay': created.kind === 'replayed',
        });
      }
      return created;
    });
    if (result.kind === 'created' || result.kind === 'replayed') {
      annotateActiveSpan({ 'order.id': result.order.id }); // the HTTP server span
    }
    switch (result.kind) {
      case 'unknown_products':
        return sendError(reply, 422, 'unknown_product', 'unknown SKUs in order', result.skus);
      case 'idempotency_conflict':
        return sendError(
          reply,
          409,
          'idempotency_key_conflict',
          'Idempotency-Key was already used with a different request',
        );
      case 'replayed':
        return reply
          .code(200)
          .header('Idempotent-Replayed', 'true')
          .header('Location', `/orders/${result.order.id}`)
          .send(orderResponse(result.order));
      case 'created':
        request.log.info({ orderId: result.order.id }, 'order created');
        return reply
          .code(201)
          .header('Location', `/orders/${result.order.id}`)
          .send(orderResponse(result.order));
    }
  });

  app.get('/orders/:id', async (request, reply) => {
    const params = orderParams.safeParse(request.params);
    if (!params.success) return sendValidationError(reply, params.error);
    const order = await getOrder(deps.pool, params.data.id);
    if (!order) return sendError(reply, 404, 'order_not_found', 'order not found');
    return orderResponse(order);
  });
}
