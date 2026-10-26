import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import type {
  HealthReport,
  IncidentDetailResponse,
  IncidentList,
  IncidentTelemetry,
} from '../src/api';

/** A stubbed fetch that answers by path, for rendering the pages against API-shaped responses. */
export type Route = (path: string) => { status?: number; body?: unknown } | Error | Promise<never>;

export function stubFetch(route: Route) {
  const calls: string[] = [];
  const fn = vi.fn((input: string) => {
    calls.push(input);
    const r = route(input);
    if (r instanceof Error) return Promise.reject(r);
    if (r instanceof Promise) return r;
    return Promise.resolve(Response.json(r.body ?? null, { status: r.status ?? 200 }));
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

const ID = 'poison-order-42-20261026T015455Z';

export function summary(
  overrides: Partial<IncidentList['incidents'][number]> = {},
): IncidentList['incidents'][number] {
  return {
    bundleId: ID,
    scenario: 'poison-order',
    seed: 42,
    createdAt: '2026-10-26T02:05:00.000Z',
    detection: { status: 'detected', latencyMs: 65_005, deadlineSeconds: 120 },
    primarySymptom: {
      description: 'Claims are recovered.',
      metric: 'commerce_claims_recovered_total',
    },
    validation: { valid: true, errorCount: 0 },
    complete: true,
    traces: [{ service: 'orders-api', traces: 12, truncated: false }],
    ...overrides,
  };
}

export function detail(overrides: Partial<IncidentDetailResponse> = {}): IncidentDetailResponse {
  return {
    ...summary(),
    window: { loadStartedAt: '2026-10-26T01:55:00.000Z', loadEndedAt: '2026-10-26T02:00:00.000Z' },
    trigger: {
      startedAt: '2026-10-26T01:55:30.000Z',
      stoppedAt: '2026-10-26T01:57:00.000Z',
      requestedDurationMs: 90_000,
    },
    producer: { commit: 'c'.repeat(40), dirty: false },
    groundTruth: {
      description: 'A poison order crashes processing.',
      rootCause: { component: 'worker', summary: 'The order cannot be priced.' },
      affectedComponents: ['worker', 'postgres'],
      primarySymptom: {
        metric: 'commerce_claims_recovered_total',
        matchers: { job: 'worker', order_status: 'pending' },
        evaluation: 'increase',
        windowSeconds: 60,
        comparison: 'gt',
        threshold: 0,
        description: 'Claims are recovered.',
      },
      secondarySymptoms: [],
      expectedRemediation: ['Quarantine the order.'],
    },
    validationErrors: [],
    files: [
      { name: 'manifest.json', bytes: 2048 },
      { name: 'logs.jsonl', bytes: null },
    ],
    sampleTraceIds: [],
    jaegerUrl: 'http://127.0.0.1:16686',
    ...overrides,
  };
}

export function telemetry(overrides: Partial<IncidentTelemetry> = {}): IncidentTelemetry {
  return {
    symptom: {
      metric: 'commerce_claims_recovered_total',
      matchers: { job: 'worker', order_status: 'pending' },
      series: [
        {
          labels: { job: 'worker' },
          samples: [
            [1792979700, 0],
            [1792979760, 2],
            [1792979820, 3],
            [1792979880, 3],
          ],
        },
      ],
      triggerStartedAt: '2026-10-26T01:55:30.000Z',
      triggerStoppedAt: '2026-10-26T01:57:00.000Z',
      detectedAt: '2026-10-26T01:56:35.005Z',
    },
    logs: {
      total: 40,
      byLevel: { info: 35, error: 5 },
      byService: { worker: 40 },
      sampleErrors: [
        {
          time: '2026-10-26T01:56:00.000Z',
          service: 'worker',
          message: 'processing failed',
          traceId: null,
        },
      ],
    },
    traces: {
      total: 12,
      samples: [
        {
          traceId: 'a'.repeat(32),
          rootName: 'order.process',
          services: ['worker'],
          spanCount: 4,
          durationMs: 120,
          startTime: '2026-10-26T01:56:00.000Z',
          error: true,
        },
      ],
    },
    ...overrides,
  };
}

export function health(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    checkedAt: '2026-10-26T03:00:00.000Z',
    components: [
      {
        name: 'orders-api',
        url: 'http://127.0.0.1:3000/readyz',
        status: 'up',
        httpStatus: 200,
        latencyMs: 4,
        detail: 'HTTP 200',
      },
      {
        name: 'worker',
        url: 'http://127.0.0.1:3001/readyz',
        status: 'down',
        httpStatus: 503,
        latencyMs: 6,
        detail: 'HTTP 503',
      },
      {
        name: 'prometheus',
        url: 'http://127.0.0.1:9090/-/ready',
        status: 'unreachable',
        httpStatus: null,
        latencyMs: null,
        detail: 'timed out',
      },
      {
        name: 'jaeger',
        url: 'http://127.0.0.1:16686/',
        status: 'up',
        httpStatus: 200,
        latencyMs: 3,
        detail: 'HTTP 200',
      },
    ],
    faults: { controls: 'disabled', activeScenario: null },
    ...overrides,
  };
}

export { ID };
