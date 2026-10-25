import { SEED_PRODUCT_COUNT, seedProduct } from '@commerce/db/catalog';
import type { Condition } from '@commerce/incident-bundle';
import { FAULT_STREAMS, stream } from './random.js';

/**
 * The five M5 scenarios (docs/prompts/m5-design.md, "Scenarios"). Every value here is part of the
 * ground truth: change a definition in a way that changes its ground truth, and raise `version`.
 */
export const SCENARIO_NAMES = [
  'api-pool-exhaustion',
  'bad-deploy-order-reads',
  'payment-timeouts',
  'poison-order',
  'provider-outage',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];
export type ProcessName = 'orders-api' | 'worker';

export const DEFAULT_DURATION_MS = 90_000;
export const TRIGGER_OFFSET_MS = 30_000;
export const MIN_DURATION_MS = 1_000;
export const MAX_DURATION_MS = 600_000;

/** Fixed parameters used by the effects. */
export const ORDER_READ_FAILURE_PERCENT = 40;
export const PAYMENT_HANG_PERCENT = 60;
export const ORDER_READ_ERROR_MESSAGE = "Cannot read properties of undefined (reading 'lines')";

export interface ScenarioDefinition {
  readonly name: ScenarioName;
  readonly version: number;
  readonly description: string;
  /** The processes whose behavior the scenario changes. */
  readonly processes: readonly ProcessName[];
  readonly rootCause: { readonly component: string; readonly summary: string };
  readonly affectedComponents: readonly string[];
  readonly faultParameters: (seed: number) => Record<string, string | number | boolean>;
  readonly primarySymptom: Condition;
  readonly secondarySymptoms: readonly Condition[];
  readonly dataEffects: readonly string[];
  readonly expectedRemediation: readonly string[];
}

const WINDOW = 60;
const DEADLINE = 120;
const increase = (
  metric: string,
  matchers: Record<string, string>,
  description: string,
  deadlineSeconds = DEADLINE,
): Condition => ({
  signal: 'metric',
  metric,
  matchers,
  evaluation: 'increase',
  windowSeconds: WINDOW,
  comparison: 'gt',
  threshold: 0,
  deadlineSeconds,
  description,
});
const gaugeAbove = (metric: string, matchers: Record<string, string>, description: string) => ({
  ...increase(metric, matchers, description),
  evaluation: 'max_over_time' as const,
});

/** The poison SKU for a seed: one catalog SKU, chosen uniformly. */
export function poisonSku(seed: number): string {
  return seedProduct(1 + stream(seed, FAULT_STREAMS.poisonSku)(SEED_PRODUCT_COUNT)).sku;
}

export const SCENARIOS: Readonly<Record<ScenarioName, ScenarioDefinition>> = Object.freeze({
  'bad-deploy-order-reads': {
    name: 'bad-deploy-order-reads',
    version: 1,
    description:
      'A release behind a configuration flag breaks the order read endpoint: a share of GET /orders/:id requests throw an unexpected error and return 500.',
    processes: ['orders-api'],
    rootCause: {
      component: 'orders-api',
      summary:
        'A faulty code path enabled by a configuration flag throws a TypeError while building the order view.',
    },
    affectedComponents: ['orders-api'],
    faultParameters: () => ({
      route: 'GET /orders/:id',
      failurePercent: ORDER_READ_FAILURE_PERCENT,
      errorMessage: ORDER_READ_ERROR_MESSAGE,
    }),
    primarySymptom: increase(
      'http_server_request_duration_seconds_count',
      { job: 'orders-api', http_route: '/orders/:id', http_response_status_code: '500' },
      'GET /orders/:id returns HTTP 500.',
    ),
    secondarySymptoms: [],
    dataEffects: ['No order, payment or stock data changes. Only order reads fail.'],
    expectedRemediation: [
      'Turn the configuration flag off, or roll back the release.',
      'Confirm GET /orders/:id returns 200 again.',
    ],
  },
  'payment-timeouts': {
    name: 'payment-timeouts',
    version: 1,
    description:
      'The payment provider stops answering a share of charge requests, so the worker times out, retries with backoff, and finally reconciles the affected orders.',
    processes: ['worker'],
    rootCause: {
      component: 'payment-provider',
      summary:
        'The payment provider leaves a share of charge requests unanswered until the client times out.',
    },
    affectedComponents: ['payment-provider', 'worker'],
    faultParameters: () => ({ operation: 'charge', hangPercent: PAYMENT_HANG_PERCENT }),
    primarySymptom: increase(
      'commerce_payment_calls_total',
      { job: 'worker', payment_operation: 'charge', payment_result: 'error' },
      'Charge calls to the payment provider fail with an unknown outcome.',
    ),
    secondarySymptoms: [
      increase(
        'commerce_worker_passes_total',
        { job: 'worker', order_pass_type: 'charge', order_pass_outcome: 'retry_scheduled' },
        'Charge passes schedule retries.',
      ),
    ],
    dataEffects: [
      'Each unanswered charge holds a worker slot until the payment timeout.',
      'Affected orders retry; once the charge budget is spent, they reconcile, and with no recorded charge they are voided and fail, releasing their stock.',
      'Orders whose retried charge is answered are paid normally.',
    ],
    expectedRemediation: [
      'Restore the payment provider.',
      'Confirm charge calls succeed and payment latency returns to normal.',
    ],
  },
  'provider-outage': {
    name: 'provider-outage',
    version: 1,
    description:
      'The payment provider is unavailable for both charges and lookups, so orders exhaust their charge budget, fail reconciliation, and park in payment_unknown with their stock held.',
    processes: ['worker'],
    rootCause: {
      component: 'payment-provider',
      summary: 'The payment provider rejects every charge and lookup as unavailable.',
    },
    affectedComponents: ['payment-provider', 'worker'],
    faultParameters: () => ({
      operations: 'charge,lookup_or_void',
      error: 'provider_unavailable',
    }),
    primarySymptom: increase(
      'commerce_payment_calls_total',
      { job: 'worker', payment_operation: 'lookup_or_void', payment_result: 'error' },
      'Reconciliation lookups against the payment provider fail.',
    ),
    secondarySymptoms: [
      gaugeAbove(
        'commerce_orders',
        { job: 'worker', order_status: 'payment_unknown' },
        'Orders park in payment_unknown.',
      ),
    ],
    dataEffects: [
      'Affected orders spend their charge budget, then their reconciliation budget, and park in payment_unknown with their stock still reserved.',
      'Parked orders are rechecked after PAYMENT_UNKNOWN_RECHECK_MS; with the provider back, they are voided and fail, releasing their stock.',
    ],
    expectedRemediation: [
      'Restore the payment provider.',
      'Let the parked orders be rechecked, or recheck them sooner, and confirm none stay in payment_unknown.',
    ],
  },
  'api-pool-exhaustion': {
    name: 'api-pool-exhaustion',
    version: 1,
    description:
      'A connection leak in the orders API holds every connection of its database pool, so requests that need the database wait for the connect timeout and fail.',
    processes: ['orders-api'],
    rootCause: {
      component: 'orders-api-pool',
      summary: 'Leaked database connections exhaust the orders API connection pool.',
    },
    affectedComponents: ['orders-api', 'orders-api-pool'],
    faultParameters: () => ({ pool: 'orders-api', heldConnections: 10 }),
    primarySymptom: increase(
      'http_server_request_duration_seconds_count',
      {
        job: 'orders-api',
        http_route: '/orders',
        http_request_method: 'POST',
        http_response_status_code: '500',
      },
      'POST /orders returns HTTP 500 after waiting for a database connection.',
    ),
    secondarySymptoms: [
      gaugeAbove(
        'db_client_connection_pending_requests',
        { job: 'orders-api', db_client_connection_pool_name: 'orders-api' },
        'Requests queue for a connection from the orders API pool.',
      ),
    ],
    dataEffects: [
      'Order creation and reads fail with 500 while the pool is exhausted; no order is created for a failed request.',
      'The orders API readiness check fails during the fault.',
    ],
    expectedRemediation: [
      'Release the leaked connections, or restart the orders API.',
      'Find and fix the code path that does not release its connection.',
    ],
  },
  'poison-order': {
    name: 'poison-order',
    version: 1,
    description:
      'Orders containing one product make every processing pass hang. Each claim of such an order holds a worker slot until its claim expires and the order is claimed again, so the worker can stall.',
    processes: ['worker'],
    rootCause: {
      component: 'worker',
      summary: 'Processing hangs for any order containing the poison SKU.',
    },
    affectedComponents: ['worker'],
    faultParameters: (seed) => ({ poisonSku: poisonSku(seed) }),
    primarySymptom: increase(
      'commerce_claims_recovered_total',
      { job: 'worker', order_status: 'pending' },
      'Expired claims are recovered and returned to pending.',
    ),
    secondarySymptoms: [
      increase(
        'commerce_worker_passes_total',
        { job: 'worker', order_pass_outcome: 'error' },
        'Hung passes end with an error once released.',
        180,
      ),
    ],
    dataEffects: [
      'Every order containing the poison SKU, placed by the incident tool or by background traffic, hangs one worker slot per claim while the fault is active.',
      'After the claim timeout, a hung order is recovered and claimed again, hanging another slot; with the default five slots the worker can stall completely.',
      'Once the fault stops, hung passes end with an error, and each affected order stays processing until its claim expires, then processes normally.',
    ],
    expectedRemediation: [
      'Identify the order or product that makes processing hang, and stop it from being processed.',
      'Fix the processing path, then let the affected orders be recovered.',
    ],
  },
});

export function isScenarioName(name: string): name is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(name);
}
