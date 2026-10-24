import * as db from '@commerce/db';
import { creationLink, markSpanError, withSpan, type Span } from '@commerce/telemetry';
import type { ClaimedOrder, Fence, Pool } from '@commerce/db';
import type { FastifyBaseLogger } from 'fastify';
import {
  chargeBackoffMs,
  lookupErrorTarget,
  selectPass,
  type Limits,
  type PassType,
} from './lifecycle.js';
import {
  PassAbortedError,
  raceAbort,
  type PassContext,
  type PassRegistry,
} from './pass-context.js';
import type { PaymentProvider, ProviderResult } from './payment/provider.js';

/** The data-access functions the processor uses. Injectable so tests can count calls. */
export type OrderStore = Pick<
  typeof db,
  | 'reserveInventory'
  | 'incrementChargeAttempt'
  | 'finalizePaid'
  | 'finalizeFailed'
  | 'retryLater'
  | 'recordLookupError'
>;

export type Step = 'reserve' | 'charge' | 'reconcile';

export interface ProcessorHooks {
  /** Called synchronously when a pass starts, before any await. */
  onPassStart?: (order: ClaimedOrder) => void;
  /** Awaited before each step. Tests use it to pause a pass at a known point. */
  beforeStep?: (step: Step, order: ClaimedOrder) => Promise<void> | void;
}

export interface ProcessorDeps {
  pool: Pool;
  provider: PaymentProvider;
  logger: FastifyBaseLogger;
  limits: Limits;
  paymentTimeoutMs: number;
  registry: PassRegistry;
  store?: OrderStore;
  hooks?: ProcessorHooks;
}

export type PassOutcome =
  | 'paid'
  | 'failed'
  | 'retry_scheduled'
  | 'reconciliation_retry'
  | 'parked'
  | 'claim_lost'
  | 'aborted'
  | 'error';

export interface Processor {
  /** Processes one claimed order. Never rejects. */
  process(order: ClaimedOrder): Promise<PassOutcome>;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function createProcessor(deps: ProcessorDeps): Processor {
  const { pool, provider, limits, registry } = deps;
  const store: OrderStore = deps.store ?? db;
  const hooks = deps.hooks ?? {};

  async function step(ctx: PassContext, name: Step): Promise<void> {
    ctx.throwIfAborted();
    const pause = hooks.beforeStep?.(name, ctx.order);
    if (pause) await raceAbort(Promise.resolve(pause), ctx.signal);
    ctx.throwIfAborted();
  }

  function claimLost(ctx: PassContext, at: string): PassOutcome {
    deps.logger.warn({ orderId: ctx.order.id, token: ctx.token, at }, 'claim_lost');
    return 'claim_lost';
  }

  /** Applies an authoritative provider result with a fenced finalize. */
  async function applyResult(
    ctx: PassContext,
    fence: Fence,
    result: ProviderResult,
    source: 'charge' | 'lookupOrVoid',
  ): Promise<PassOutcome> {
    const log = { orderId: fence.orderId, token: fence.token, source, replayed: result.replayed };
    if (result.outcome === 'approved') {
      const reference = result.reference;
      if (reference === null) throw new Error('approved ledger row without a reference');
      const ok = await finalizeStep(ctx, 'paid', () =>
        ctx.withClient((c) => store.finalizePaid(c, { ...fence, paymentReference: reference })),
      );
      if (!ok) return claimLost(ctx, 'finalize_paid');
      deps.logger.info({ ...log, paymentReference: reference }, 'order_paid');
      return 'paid';
    }
    const reason = result.outcome === 'declined' ? 'payment_declined' : 'max_attempts_exceeded';
    const ok = await finalizeStep(ctx, 'failed', () =>
      ctx.withClient((c) => store.finalizeFailed(c, { ...fence, reason })),
    );
    if (!ok) return claimLost(ctx, 'finalize_failed');
    deps.logger.info({ ...log, reason }, 'order_failed');
    return 'failed';
  }

  /** Reconciliation: one lookupOrVoid, never a charge, never a reservation. */
  async function reconcile(ctx: PassContext, fence: Fence, pass: Span): Promise<PassOutcome> {
    await step(ctx, 'reconcile');
    const lookup = await providerCall(ctx, pass, 'payment.lookup_or_void', () =>
      provider.lookupOrVoid(fence.orderId),
    );
    let result: ProviderResult;
    if (lookup.ok) {
      result = lookup.result;
    } else {
      const err = lookup.err;
      const attempts = ctx.order.reconciliationAttempts + 1;
      const target = lookupErrorTarget(attempts, limits);
      const ok = await finalizeStep(ctx, target.parked ? 'payment_unknown' : 'pending', () =>
        ctx.withClient((c) =>
          store.recordLookupError(c, { ...fence, ...target, lastError: describeError(err) }),
        ),
      );
      if (!ok) return claimLost(ctx, 'record_lookup_error');
      deps.logger.warn(
        {
          orderId: fence.orderId,
          token: fence.token,
          reconciliationAttempts: attempts,
          parked: target.parked,
          retryInMs: target.delayMs,
          err: describeError(err),
        },
        target.parked ? 'payment_unknown' : 'lookup_failed',
      );
      return target.parked ? 'parked' : 'reconciliation_retry';
    }
    return applyResult(ctx, fence, result, 'lookupOrVoid');
  }

  async function chargePass(ctx: PassContext, fence: Fence, pass: Span): Promise<PassOutcome> {
    const order = ctx.order;
    const paymentMethod = order.paymentMethod;
    if (paymentMethod === null) throw new Error(`order ${order.id} has no payment method`);

    await step(ctx, 'reserve');
    let chargeAttempts: number;
    if (order.inventoryReservedAt === null) {
      const reservation = await withSpan('order.reserve', {}, () =>
        ctx.withClient((c) => store.reserveInventory(c, fence)),
      );
      if (reservation.kind === 'claim_lost') return claimLost(ctx, 'reserve');
      if (reservation.kind === 'out_of_stock') {
        deps.logger.info({ ...fence, reason: 'out_of_stock' }, 'order_failed');
        return 'failed';
      }
      chargeAttempts = reservation.chargeAttempts;
      ctx.inventoryReserved = true;
    } else {
      deps.logger.info({ ...fence }, 'reservation_skipped');
      const counted = await withSpan(
        'order.reserve',
        { attributes: { 'order.reservation_skipped': true } },
        () =>
          ctx.withClient((c) =>
            store.incrementChargeAttempt(c, {
              ...fence,
              maxChargeAttempts: limits.maxChargeAttempts,
            }),
          ),
      );
      if (counted === null) return claimLost(ctx, 'charge_increment');
      chargeAttempts = counted;
    }

    await step(ctx, 'charge');
    const charge = await providerCall(ctx, pass, 'payment.charge', () =>
      provider.charge({ orderId: order.id, amountCents: order.totalCents, paymentMethod }),
    );
    if (!charge.ok) {
      const err = charge.err;
      // Unknown outcome. Never evidence that no charge exists.
      deps.logger.warn(
        { ...fence, chargeAttempts, err: describeError(err) },
        'charge_outcome_unknown',
      );
      if (chargeAttempts < limits.maxChargeAttempts) {
        const delayMs = chargeBackoffMs(chargeAttempts, limits);
        const ok = await finalizeStep(ctx, 'pending', () =>
          ctx.withClient((c) =>
            store.retryLater(c, { ...fence, delayMs, lastError: describeError(err) }),
          ),
        );
        if (!ok) return claimLost(ctx, 'retry_later');
        deps.logger.info(
          { ...fence, chargeAttempts, retryInMs: delayMs },
          'charge_retry_scheduled',
        );
        return 'retry_scheduled';
      }
      return reconcile(ctx, fence, pass);
    }
    return applyResult(ctx, fence, charge.result, 'charge');
  }

  async function run(ctx: PassContext, pass: PassType, span: Span): Promise<PassOutcome> {
    const order = ctx.order;
    const fence: Fence = { orderId: order.id, token: order.processingAttempts };
    deps.logger.info(
      {
        ...fence,
        pass,
        chargeAttempts: order.chargeAttempts,
        reconciliationAttempts: order.reconciliationAttempts,
      },
      'pass_started',
    );
    return pass === 'reconciliation' ? reconcile(ctx, fence, span) : chargePass(ctx, fence, span);
  }

  return {
    process(order: ClaimedOrder): Promise<PassOutcome> {
      const ctx = registry.start(order, pool);
      hooks.onPassStart?.(order);
      const pass: PassType = selectPass(order, limits);
      // M3b: every pass is its own trace (a root span, never a child of whatever is active),
      // linked to the order's creation trace. See docs/prompts/m3-design.md.
      const link = creationLink(order.traceContext, order.id);
      return withSpan(
        'order.process',
        {
          root: true,
          kind: 'consumer',
          links: link.links,
          attributes: {
            ...link.attributes,
            'order.id': order.id,
            'order.pass.type': pass,
            'order.processing_attempt': order.processingAttempts,
            'order.charge_attempts': order.chargeAttempts,
            'order.reconciliation_attempts': order.reconciliationAttempts,
          },
        },
        (span) => runTraced(ctx, pass, span),
      ).finally(() => {
        registry.finish(ctx);
      });
    },
  };

  async function runTraced(ctx: PassContext, pass: PassType, span: Span): Promise<PassOutcome> {
    const order = ctx.order;
    const outcome = await run(ctx, pass, span).catch((err: unknown): PassOutcome => {
      if (err instanceof PassAbortedError || ctx.aborted) {
        deps.logger.warn({ orderId: order.id, token: ctx.token }, 'pass_aborted');
        return 'aborted';
      }
      // The order stays `processing`; recovery returns it after the claim timeout.
      deps.logger.error(
        { orderId: order.id, token: ctx.token, err: describeError(err) },
        'pass_failed',
      );
      return 'error';
    });
    span.setAttribute('order.pass.outcome', outcome);
    if (outcome === 'error' || outcome === 'aborted') markSpanError(span, `pass ${outcome}`);
    return outcome;
  }

  /**
   * A finalize write inside its own child span, tagged with the target status and with
   * `order.inventory_released`. Stock is released exactly when a finalize to `failed` matches and
   * the order was reserved: finalizeFailed releases only a reserved, not-yet-released order, a
   * terminal transition happens once, and fencing means only this pass can have reserved it.
   * Tracing only: the write and its result are unchanged.
   */
  function finalizeStep(
    ctx: PassContext,
    target: string,
    write: () => Promise<boolean>,
  ): Promise<boolean> {
    return withSpan(
      'order.finalize',
      { attributes: { 'order.finalize.target': target } },
      async (span) => {
        const ok = await write();
        span.setAttribute(
          'order.inventory_released',
          target === 'failed' && ok && ctx.inventoryReserved,
        );
        return ok;
      },
    );
  }

  /**
   * One provider call inside its own child span. An authoritative result is recorded as
   * `payment.result` and `payment.replayed`. An unknown outcome is not an error: it sets
   * `payment.result = "error"` and adds a `payment.outcome_unknown` event to the pass span.
   * The payment reference is never recorded. An abort still propagates.
   */
  async function providerCall(
    ctx: PassContext,
    pass: Span,
    name: 'payment.charge' | 'payment.lookup_or_void',
    call: () => Promise<ProviderResult>,
  ): Promise<{ ok: true; result: ProviderResult } | { ok: false; err: unknown }> {
    return withSpan(name, {}, async (span) => {
      try {
        const result = await ctx.callProvider(call, deps.paymentTimeoutMs);
        span.setAttributes({
          'payment.result': result.outcome,
          'payment.replayed': result.replayed,
        });
        return { ok: true as const, result };
      } catch (err) {
        if (err instanceof PassAbortedError) throw err;
        span.setAttribute('payment.result', 'error');
        pass.addEvent('payment.outcome_unknown', {
          'payment.operation': name.slice('payment.'.length),
        });
        return { ok: false as const, err };
      }
    });
  }
}
