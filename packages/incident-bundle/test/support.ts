import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BundleContents, GroundTruth, ManifestBody } from '../src/index.js';

/** Test bundles are generated in temporary directories and never committed (CLAUDE.md). */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'incident-bundle-test-'));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const BUNDLE_ID = 'payment-timeouts-42-20261025T140000Z';
const TRACE = 'a'.repeat(32);
const at = (s: number) => new Date(Date.UTC(2026, 9, 25, 14, 0, s)).toISOString();

export function groundTruth(): GroundTruth {
  return {
    schemaVersion: '1.0.0',
    scenario: { name: 'payment-timeouts', version: 1, seed: 42 },
    description: 'A description.',
    rootCause: { component: 'payment-provider', summary: 'A summary.' },
    affectedComponents: ['payment-provider', 'worker'],
    faultParameters: { hangPercent: 60 },
    timeline: { triggerOffsetMs: 30000, durationMs: 90000 },
    primarySymptom: {
      signal: 'metric',
      metric: 'commerce_payment_calls_total',
      matchers: { job: 'worker', payment_result: 'error' },
      evaluation: 'increase',
      windowSeconds: 60,
      comparison: 'gt',
      threshold: 0,
      deadlineSeconds: 120,
      description: 'Charges fail.',
    },
    secondarySymptoms: [],
    dataEffects: ['An effect.'],
    expectedRemediation: ['A step.'],
  };
}

export function manifestBody(): ManifestBody {
  return {
    schemaVersion: '1.0.0',
    bundleId: BUNDLE_ID,
    createdAt: at(59),
    scenario: { name: 'payment-timeouts', version: 1, seed: 42 },
    window: { loadStartedAt: at(0), loadEndedAt: at(30), captureFrom: at(0), captureTo: at(45) },
    trigger: { startedAt: at(5), stoppedAt: at(20), requestedDurationMs: 90000 },
    detection: { detectedAt: at(8), latencyMs: 3000, deadlineSeconds: 120 },
    producer: { repository: 'commerce-platform', commit: 'c'.repeat(40), dirty: false },
    services: [{ name: 'orders-api', version: '0.0.0', instanceId: 'api-1' }],
    infrastructure: { images: { jaeger: 'jaegertracing/jaeger:2.22.0' } },
    load: { profile: 'incident', seed: 42, planHash: 'b'.repeat(64), runPrefix: 'run-1' },
    capture: {
      traces: {
        source: 'jaeger-v3',
        sliceSeconds: 10,
        minSliceSeconds: 1,
        searchDepth: 1000,
        maxTracesPerService: 5000,
        droppedAdminSpans: 0,
        services: [
          {
            name: 'orders-api',
            traces: 1,
            saturatedSlices: 0,
            truncated: false,
            truncationReasons: [],
          },
        ],
      },
      metrics: {
        source: 'prometheus',
        stepSeconds: 5,
        series: [{ name: 'commerce_payment_calls_total', seriesCount: 1 }],
      },
      logs: {
        source: 'docker-compose',
        services: [{ name: 'orders-api', records: 1, nonJsonLines: 0, droppedAdminLines: 0 }],
      },
    },
  };
}

export function contents(): BundleContents {
  return {
    manifest: manifestBody(),
    groundTruth: groundTruth(),
    traces: [
      {
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: 'service.name', value: { stringValue: 'orders-api' } }],
            },
            scopeSpans: [
              {
                scope: { name: '@opentelemetry/instrumentation-http' },
                spans: [
                  {
                    traceId: TRACE,
                    spanId: '1'.repeat(16),
                    name: 'POST /orders',
                    startTimeUnixNano: '1',
                  },
                  {
                    traceId: TRACE,
                    spanId: '2'.repeat(16),
                    name: 'pg.query',
                    startTimeUnixNano: '2',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    metrics: [
      {
        name: 'commerce_payment_calls_total',
        labels: { job: 'worker', payment_result: 'error' },
        samples: [
          [1792940630, '3'],
          [1792940635, 'NaN'],
        ],
      },
    ],
    logs: [
      {
        service: 'orders-api',
        time: at(6),
        level: 'error',
        message: 'request errored',
        attributes: { reqId: 'req-1' },
        trace_id: TRACE,
        span_id: '1'.repeat(16),
      },
    ],
  };
}
