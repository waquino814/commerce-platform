import { setTimeout as sleep } from 'node:timers/promises';
import { claimPendingOrders, type Pool } from '@commerce/db';
import type { FastifyBaseLogger } from 'fastify';

export interface WorkerLoopDeps {
  pool: Pool;
  logger: FastifyBaseLogger;
  workerId: string;
  pollIntervalMs: number;
  claimBatchSize: number;
}

/**
 * Polls for pending orders and claims them until `signal` aborts.
 *
 * M1 scope: claiming only. Claimed orders stay in `processing`. Inventory reservation,
 * payment simulation, and stale-claim recovery arrive in M2.
 *
 * Database errors are logged and retried on the next poll, so a Postgres outage
 * does not crash the worker. Resolves once the in-flight iteration finishes after abort.
 */
export async function runWorkerLoop(deps: WorkerLoopDeps, signal: AbortSignal): Promise<void> {
  const { pool, logger, workerId, pollIntervalMs, claimBatchSize } = deps;
  logger.info({ pollIntervalMs, claimBatchSize }, 'worker loop started');

  while (!signal.aborted) {
    let claimedFullBatch = false;
    try {
      const claimed = await claimPendingOrders(pool, { workerId, limit: claimBatchSize });
      for (const order of claimed) {
        logger.info(
          { orderId: order.id, attempt: order.processingAttempts },
          'order claimed for processing',
        );
      }
      claimedFullBatch = claimed.length === claimBatchSize;
    } catch (err) {
      logger.error({ err }, 'claiming pending orders failed');
    }

    // A full batch suggests more work is waiting, so poll again immediately.
    if (claimedFullBatch) continue;
    await sleep(pollIntervalMs, undefined, { signal }).catch(() => undefined);
  }

  logger.info('worker loop stopped');
}
