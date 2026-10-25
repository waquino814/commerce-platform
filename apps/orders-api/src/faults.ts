import {
  createFaultController,
  createOrderReadFault,
  createPoolLeak,
  createScenarioControl,
  createWorkerForwarder,
  type FaultController,
  type PoolLike,
  type ScenarioControl,
} from '@commerce/faults';

/**
 * The orders API's part of M5's fault injection: `bad-deploy-order-reads` and
 * `api-pool-exhaustion`. Built only when `FAULTS_ENABLED=true`; worker-only scenarios are tracked
 * here for the report and forwarded to the worker.
 */
export interface ApiFaults {
  readonly controller: FaultController;
  readonly control: ScenarioControl;
  readonly orderReadFault: { shouldFail(): boolean };
  readonly poolLeak: { heldCount(): number; settled(): Promise<void> };
}

export function createApiFaults(deps: {
  pool: PoolLike;
  workerAdminUrl: string;
  fetch?: typeof fetch;
}): ApiFaults {
  const orderRead = createOrderReadFault();
  const poolLeak = createPoolLeak(deps.pool);
  const controller = createFaultController({
    effects: {
      'bad-deploy-order-reads': orderRead.effect,
      'api-pool-exhaustion': poolLeak.effect,
    },
  });
  const forwarder = createWorkerForwarder({
    baseUrl: deps.workerAdminUrl,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return {
    controller,
    control: createScenarioControl({ process: 'orders-api', controller, forwarder }),
    orderReadFault: orderRead,
    poolLeak,
  };
}
