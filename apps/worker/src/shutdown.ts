import {
  releaseClaims,
  stillHeldClaims,
  type Fence,
  type Pool,
  type RequeuePolicy,
} from '@commerce/db';
import { recordSweep } from '@commerce/telemetry';
import type { FastifyBaseLogger } from 'fastify';
import type { PassRegistry } from './pass-context.js';

export const DRAIN_DEADLINE_MS = 7000;
export const RELEASE_STATEMENT_TIMEOUT_MS = 500;

export interface ReleaseResult {
  released: string[];
  /** Still `processing` with our token: the release could not be confirmed. */
  unconfirmed: string[];
}

export type ClaimReleaser = (claims: Fence[]) => Promise<ReleaseResult>;

/**
 * Releases unfinished claims with one fenced statement that skips locked rows, then reads which
 * of the remaining claims are still held. Any error leaves every claim unconfirmed.
 *
 * M3b: when `traceContextOf` is given, the release is also recorded as one `worker.release_claims`
 * root span with one `order.claim_released` child per released or unconfirmed order, linked to its
 * creation trace. Contexts are read synchronously on entry, while the aborted passes are still in
 * the registry. Tracing never changes the returned result.
 */
export function createClaimReleaser(
  pool: Pool,
  policy: RequeuePolicy,
  logger: FastifyBaseLogger,
  traceContextOf?: (orderId: string) => string | null,
): ClaimReleaser {
  const release: ClaimReleaser = async (claims) => {
    if (claims.length === 0) return { released: [], unconfirmed: [] };
    try {
      const client = await pool.connect();
      let released: string[];
      try {
        released = await releaseClaims(client, {
          ...policy,
          claims,
          statementTimeoutMs: RELEASE_STATEMENT_TIMEOUT_MS,
        });
      } finally {
        client.release();
      }
      const remaining = claims.filter((c) => !released.includes(c.orderId));
      const unconfirmed = await stillHeldClaims(pool, remaining);
      return { released, unconfirmed };
    } catch (err) {
      logger.error({ err }, 'claim release failed');
      return { released: [], unconfirmed: claims.map((c) => c.orderId) };
    }
  };
  if (!traceContextOf) return release;

  return async (claims) => {
    const startTime = Date.now();
    const contexts = new Map(claims.map((c) => [c.orderId, traceContextOf(c.orderId)]));
    const result = await release(claims);
    const items = [
      ...result.released.map((orderId) => ({ orderId, result: 'released' as const })),
      ...result.unconfirmed.map((orderId) => ({ orderId, result: 'unconfirmed' as const })),
    ];
    const resultOf = new Map(items.map((i) => [i.orderId, i.result]));
    recordSweep({
      name: 'worker.release_claims',
      childName: 'order.claim_released',
      startTime,
      attributes: {
        'release.released': result.released.length,
        'release.unconfirmed': result.unconfirmed.length,
      },
      items: items.map((i) => ({
        orderId: i.orderId,
        traceContext: contexts.get(i.orderId) ?? null,
        attributes: { 'release.result': i.result },
      })),
      onItem: (item) => {
        logger.warn(
          { orderId: item.orderId, result: resultOf.get(item.orderId) },
          'claim_released',
        );
      },
    });
    return result;
  };
}

export interface ShutdownDeps {
  /** Stops the loop from claiming and recovering. */
  stopLoop: () => void;
  /** Resolves when the loop has exited, after dispatching any in-flight claim. */
  loopDone: Promise<void>;
  registry: PassRegistry;
  /** Resolves at the drain deadline. Injectable so tests need no timers. */
  drainDeadline: Promise<void>;
  release: ClaimReleaser;
  logger: FastifyBaseLogger;
}

export interface ShutdownResult {
  exitCode: 0 | 1;
  drained: boolean;
  released: string[];
  unconfirmed: string[];
}

/**
 * Shutdown protocol: stop claiming, drain until the deadline, then abort the remaining passes
 * (which writes nothing and destroys their connections) and release their claims. Shutdown
 * never sets `failed`, never releases inventory, and never calls the provider.
 */
export async function shutdownWorker(deps: ShutdownDeps): Promise<ShutdownResult> {
  const { registry, logger } = deps;
  deps.stopLoop();
  await deps.loopDone;

  const drained = await Promise.race([
    registry.whenIdle().then(() => true),
    deps.drainDeadline.then(() => false),
  ]);
  if (drained || registry.size === 0) {
    logger.info('shutdown drained all in-flight orders');
    return { exitCode: 0, drained: true, released: [], unconfirmed: [] };
  }

  const unfinished = registry.snapshot();
  const claims: Fence[] = unfinished.map((ctx) => ({ orderId: ctx.order.id, token: ctx.token }));
  for (const ctx of unfinished) ctx.abort();
  logger.warn({ orders: claims.map((c) => c.orderId) }, 'drain deadline reached, aborting passes');

  const result = await deps.release(claims);
  const exitCode = result.unconfirmed.length > 0 ? 1 : 0;
  logger[exitCode === 0 ? 'info' : 'error'](
    { released: result.released, unconfirmed: result.unconfirmed },
    exitCode === 0 ? 'claims released' : 'claim release unconfirmed; recovery will requeue',
  );
  return { exitCode, drained: false, ...result };
}
