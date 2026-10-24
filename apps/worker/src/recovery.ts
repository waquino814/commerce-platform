import { recoverExpiredClaimsWithContext, type Pool, type RequeuePolicy } from '@commerce/db';
import { createWorkerMetrics, recordSweep, type WorkerMetrics } from '@commerce/telemetry';
import type { FastifyBaseLogger } from 'fastify';

export interface RecovererDeps {
  pool: Pool;
  logger: FastifyBaseLogger;
  params: RequeuePolicy & { claimTimeoutMs: number; retryBaseMs: number; retryMaxMs: number };
  now?: () => number;
  /** M3c claim metrics. Defaults to the global meter, a no-op when telemetry is off. */
  metrics?: WorkerMetrics;
}

/**
 * Claim recovery for the worker loop. Behavior is M2's recoverExpiredClaims; M3b only adds
 * tracing: a sweep that recovered orders becomes one `worker.recover_claims` root span with one
 * `order.claim_recovered` child per order, linked to its creation trace, and one log line per order
 * inside that child. A sweep that recovered nothing records nothing. M3c also counts recovered
 * orders by target status.
 */
export function createClaimRecoverer(deps: RecovererDeps): () => Promise<number> {
  const now = deps.now ?? Date.now;
  const metrics = deps.metrics ?? createWorkerMetrics();
  return async () => {
    const startTime = now();
    const recovered = await recoverExpiredClaimsWithContext(deps.pool, deps.params);
    const byId = new Map(recovered.map((r) => [r.id, r]));
    recordSweep({
      name: 'worker.recover_claims',
      childName: 'order.claim_recovered',
      startTime,
      attributes: { 'claims.recovered': recovered.length },
      items: recovered.map((r) => ({
        orderId: r.id,
        traceContext: r.traceContext,
        attributes: { 'order.status': r.status, 'order.processing_attempt': r.processingAttempts },
      })),
      onItem: (item) => {
        const r = byId.get(item.orderId);
        deps.logger.warn(
          { orderId: item.orderId, status: r?.status, processingAttempts: r?.processingAttempts },
          'claim_recovered',
        );
      },
    });
    metrics.claimsRecovered('pending', recovered.filter((r) => r.status === 'pending').length);
    metrics.claimsRecovered(
      'payment_unknown',
      recovered.filter((r) => r.status === 'payment_unknown').length,
    );
    return recovered.length;
  };
}
