import {
  createFaultController,
  createPaymentFaults,
  createPoisonFault,
  createScenarioControl,
  type FaultController,
  type ScenarioControl,
} from '@commerce/faults';
import type { ProcessorHooks } from './processor.js';
import { ProviderError, type PaymentProvider } from './payment/provider.js';

/**
 * The worker's part of M5's fault injection: `payment-timeouts`, `provider-outage` and
 * `poison-order`. Built only when `FAULTS_ENABLED=true`. Faults reach the worker only through its
 * payment provider and the processor's `beforeStep` hook.
 */
export interface WorkerFaults {
  readonly controller: FaultController;
  readonly control: ScenarioControl;
  wrapProvider(provider: PaymentProvider): PaymentProvider;
  readonly hooks: ProcessorHooks;
  pendingPaymentCalls(): number;
  hungPasses(): number;
}

export function createWorkerFaults(deps: {
  skusOf: (orderId: string) => Promise<readonly string[]>;
}): WorkerFaults {
  const payment = createPaymentFaults({
    unavailable: () => new ProviderError('provider_unavailable'),
    reset: () => new ProviderError('connection_reset'),
  });
  const poison = createPoisonFault({ skusOf: deps.skusOf });
  const controller = createFaultController({
    effects: {
      'payment-timeouts': payment.timeouts,
      'provider-outage': payment.outage,
      'poison-order': poison.effect,
    },
  });
  return {
    controller,
    control: createScenarioControl({ process: 'worker', controller }),
    wrapProvider: (provider) => payment.wrap(provider),
    hooks: { beforeStep: (step, order) => poison.beforeStep(step, order) },
    pendingPaymentCalls: () => payment.pendingCount(),
    hungPasses: () => poison.hungCount(),
  };
}
