import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PaymentMethod, Pool, PoolClient } from '@commerce/db';
import type { FastifyBaseLogger } from 'fastify';
import {
  ProviderError,
  type ChargeRequest,
  type LedgerOutcome,
  type PaymentProvider,
  type ProviderResult,
} from './provider.js';

/**
 * First key of the two-number advisory lock (ASCII "PAYS"). Two-number keys never overlap the
 * single-number key space used by the migration runner.
 */
export const LEDGER_LOCK_NAMESPACE = 0x50415953;

export interface SimulatorDeps {
  /** The simulator's own pool: it stands in for an external provider. */
  pool: Pool;
  logger: FastifyBaseLogger;
  latencyMs: number;
  /** Test seam: replaces the simulated processing delay, which runs while the lock is held. */
  simulateLatency?: (orderId: string) => Promise<void>;
}

interface LedgerRow {
  outcome: LedgerOutcome;
  reference: string | null;
  amount_cents: number | null;
}

const UNIQUE_VIOLATION = '23505';

/** Deterministic per order, so repeated runs produce the same references. */
export function paymentReference(orderId: string): string {
  return `sim_${createHash('sha256').update(orderId).digest('hex').slice(0, 16)}`;
}

function decide(method: PaymentMethod): LedgerOutcome | 'unavailable' {
  switch (method) {
    case 'pm_card_ok':
      return 'approved';
    case 'pm_card_declined':
      return 'declined';
    case 'pm_card_unavailable':
      return 'unavailable';
  }
}

async function readLedger(client: PoolClient, orderId: string): Promise<LedgerRow | undefined> {
  const result = await client.query<LedgerRow>(
    'SELECT outcome, reference, amount_cents FROM payment_charges WHERE order_id = $1',
    [orderId],
  );
  return result.rows[0];
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * In-process payment provider backed by the `payment_charges` ledger.
 *
 * Every call is one transaction that takes a per-order advisory lock before reading the ledger
 * and holds it until COMMIT, so read, decide and record form one critical section per order.
 * A concurrent call for the same order waits in Postgres's lock queue and then reads what the
 * first one recorded. The primary key is only a backstop: inserts do not use ON CONFLICT, so a
 * duplicate can only come from a bug that bypassed the lock, and it is logged.
 */
export function createPaymentSimulator(deps: SimulatorDeps): PaymentProvider {
  const { pool, logger } = deps;
  const simulateLatency =
    deps.simulateLatency ?? ((): Promise<void> => sleep(deps.latencyMs).then(() => undefined));

  async function withOrderLock(
    orderId: string,
    operation: string,
    body: (client: PoolClient) => Promise<ProviderResult>,
    expectedAmountCents?: number,
  ): Promise<ProviderResult> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        LEDGER_LOCK_NAMESPACE,
        orderId,
      ]);
      const existing = await readLedger(client, orderId);
      if (existing) {
        await client.query('COMMIT');
        if (
          expectedAmountCents !== undefined &&
          existing.amount_cents !== null &&
          existing.amount_cents !== expectedAmountCents
        ) {
          logger.warn(
            { orderId, recorded: existing.amount_cents, requested: expectedAmountCents },
            'amount_mismatch',
          );
        }
        return { outcome: existing.outcome, reference: existing.reference, replayed: true };
      }
      return await body(client);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUniqueViolation(err)) {
        // Only reachable if something wrote the ledger without the lock.
        const stored = await readLedger(client, orderId);
        logger.error({ orderId, operation }, 'ledger_lock_bypassed');
        if (stored) return { outcome: stored.outcome, reference: stored.reference, replayed: true };
      }
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`simulator_error: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      client.release();
    }
  }

  return {
    charge(request: ChargeRequest): Promise<ProviderResult> {
      return withOrderLock(
        request.orderId,
        'charge',
        async (client) => {
          await simulateLatency(request.orderId);
          const decision = decide(request.paymentMethod);
          if (decision === 'unavailable') {
            await client.query('COMMIT');
            throw new ProviderError('provider_unavailable');
          }
          const reference = paymentReference(request.orderId);
          await client.query(
            `INSERT INTO payment_charges (order_id, outcome, reference, amount_cents)
           VALUES ($1, $2, $3, $4)`,
            [request.orderId, decision, reference, request.amountCents],
          );
          await client.query('COMMIT');
          return { outcome: decision, reference, replayed: false };
        },
        request.amountCents,
      ).then((result) => {
        if (result.replayed) {
          logger.info({ orderId: request.orderId, outcome: result.outcome }, 'charge_replayed');
        }
        return result;
      });
    },

    lookupOrVoid(orderId: string): Promise<ProviderResult> {
      return withOrderLock(orderId, 'lookupOrVoid', async (client) => {
        await client.query(
          `INSERT INTO payment_charges (order_id, outcome, reference, amount_cents)
           VALUES ($1, 'voided', NULL, NULL)`,
          [orderId],
        );
        await client.query('COMMIT');
        logger.info({ orderId }, 'charge_voided');
        return { outcome: 'voided', reference: null, replayed: false };
      });
    },
  };
}
