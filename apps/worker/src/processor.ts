import * as db from '@commerce/db';
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
      const ok = await ctx.withClient((c) =>
        store.finalizePaid(c, { ...fence, paymentReference: reference }),
      );
      if (!ok) return claimLost(ctx, 'finalize_paid');
      deps.logger.info({ ...log, paymentReference: reference }, 'order_paid');
      return 'paid';
    }
    const reason = result.outcome === 'declined' ? 'payment_declined' : 'max_attempts_exceeded';
    const ok = await ctx.withClient((c) => store.finalizeFailed(c, { ...fence, reason }));
    if (!ok) return claimLost(ctx, 'finalize_failed');
    deps.logger.info({ ...log, reason }, 'order_failed');
    return 'failed';
  }

  /** Reconciliation: one lookupOrVoid, never a charge, never a reservation. */
  async function reconcile(ctx: PassContext, fence: Fence): Promise<PassOutcome> {
    await step(ctx, 'reconcile');
    let result: ProviderResult;
    try {
      result = await ctx.callProvider(
        () => provider.lookupOrVoid(fence.orderId),
        deps.paymentTimeoutMs,
      );
    } catch (err) {
      if (err instanceof PassAbortedError) throw err;
      const attempts = ctx.order.reconciliationAttempts + 1;
      const target = lookupErrorTarget(attempts, limits);
      const ok = await ctx.withClient((c) =>
        store.recordLookupError(c, { ...fence, ...target, lastError: describeError(err) }),
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

  async function chargePass(ctx: PassContext, fence: Fence): Promise<PassOutcome> {
    const order = ctx.order;
    const paymentMethod = order.paymentMethod;
    if (paymentMethod === null) throw new Error(`order ${order.id} has no payment method`);

    await step(ctx, 'reserve');
    let chargeAttempts: number;
    if (order.inventoryReservedAt === null) {
      const reservation = await ctx.withClient((c) => store.reserveInventory(c, fence));
      if (reservation.kind === 'claim_lost') return claimLost(ctx, 'reserve');
      if (reservation.kind === 'out_of_stock') {
        deps.logger.info({ ...fence, reason: 'out_of_stock' }, 'order_failed');
        return 'failed';
      }
      chargeAttempts = reservation.chargeAttempts;
    } else {
      deps.logger.info({ ...fence }, 'reservation_skipped');
      const counted = await ctx.withClient((c) =>
        store.incrementChargeAttempt(c, { ...fence, maxChargeAttempts: limits.maxChargeAttempts }),
      );
      if (counted === null) return claimLost(ctx, 'charge_increment');
      chargeAttempts = counted;
    }

    await step(ctx, 'charge');
    let result: ProviderResult;
    try {
      result = await ctx.callProvider(
        () => provider.charge({ orderId: order.id, amountCents: order.totalCents, paymentMethod }),
        deps.paymentTimeoutMs,
      );
    } catch (err) {
      if (err instanceof PassAbortedError) throw err;
      // Unknown outcome. Never evidence that no charge exists.
      deps.logger.warn(
        { ...fence, chargeAttempts, err: describeError(err) },
        'charge_outcome_unknown',
      );
      if (chargeAttempts < limits.maxChargeAttempts) {
        const delayMs = chargeBackoffMs(chargeAttempts, limits);
        const ok = await ctx.withClient((c) =>
          store.retryLater(c, { ...fence, delayMs, lastError: describeError(err) }),
        );
        if (!ok) return claimLost(ctx, 'retry_later');
        deps.logger.info(
          { ...fence, chargeAttempts, retryInMs: delayMs },
          'charge_retry_scheduled',
        );
        return 'retry_scheduled';
      }
      return reconcile(ctx, fence);
    }
    return applyResult(ctx, fence, result, 'charge');
  }

  async function run(ctx: PassContext): Promise<PassOutcome> {
    const order = ctx.order;
    const fence: Fence = { orderId: order.id, token: order.processingAttempts };
    const pass: PassType = selectPass(order, limits);
    deps.logger.info(
      {
        ...fence,
        pass,
        chargeAttempts: order.chargeAttempts,
        reconciliationAttempts: order.reconciliationAttempts,
      },
      'pass_started',
    );
    return pass === 'reconciliation' ? reconcile(ctx, fence) : chargePass(ctx, fence);
  }

  return {
    process(order: ClaimedOrder): Promise<PassOutcome> {
      const ctx = registry.start(order, pool);
      hooks.onPassStart?.(order);
      return run(ctx)
        .catch((err: unknown): PassOutcome => {
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
        })
        .finally(() => {
          registry.finish(ctx);
        });
    },
  };
}
