import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { METRIC } from '../../telemetry/src/metrics.js';
import { describe, expect, it } from 'vitest';
import { buildGroundTruth, groundTruthJson } from '../src/ground-truth.js';
import { poisonSku, SCENARIO_NAMES, SCENARIOS } from '../src/scenarios.js';

/** M5a criterion A7: deterministic ground truth with committed golden files for seed 42. */
const golden = (name: string) => new URL(`./golden/${name}-42.json`, import.meta.url);

/** The M3 catalog in Prometheus form: the name the collector exports and the label keys allowed. */
const CATALOG: Record<string, readonly string[]> = {
  http_server_request_duration_seconds_count: [
    'http_request_method',
    'http_route',
    'http_response_status_code',
  ],
  db_client_connection_pending_requests: ['db_client_connection_pool_name'],
  commerce_orders: ['order_status'],
  commerce_worker_passes_total: ['order_pass_type', 'order_pass_outcome'],
  commerce_payment_calls_total: ['payment_operation', 'payment_result', 'payment_replayed'],
  commerce_claims_recovered_total: ['order_status'],
};
const instrumentFor: Record<string, string> = {
  http_server_request_duration_seconds_count: METRIC.httpServerRequestDuration,
  db_client_connection_pending_requests: METRIC.dbConnectionPendingRequests,
  commerce_orders: METRIC.orders,
  commerce_worker_passes_total: METRIC.workerPasses,
  commerce_payment_calls_total: METRIC.paymentCalls,
  commerce_claims_recovered_total: METRIC.claimsRecovered,
};

describe('ground truth (A7)', () => {
  for (const name of SCENARIO_NAMES) {
    it(`${name}: seed 42 equals its committed golden file`, () => {
      const text = groundTruthJson(name, 42);
      if (process.env.WRITE_GOLDEN === '1') writeFileSync(golden(name), text);
      expect(readFileSync(golden(name), 'utf8')).toBe(text);
    });
  }

  it('is byte-identical across calls, and across processes', () => {
    for (const name of SCENARIO_NAMES) {
      expect(groundTruthJson(name, 42)).toBe(groundTruthJson(name, 42));
    }
    // A second Node process computes the same bytes from the TypeScript source.
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const out = execFileSync(
      process.execPath,
      [
        '--conditions=@commerce/source',
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "import { groundTruthJson } from './packages/faults/src/ground-truth.ts'; process.stdout.write(groundTruthJson('poison-order', 42));",
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(out).toBe(groundTruthJson('poison-order', 42));
  });

  it('a different seed changes only the seed and seed-derived parameters', () => {
    for (const name of SCENARIO_NAMES) {
      const a = buildGroundTruth(name, 42);
      const b = buildGroundTruth(name, 7);
      expect(b.affectedComponents).toEqual(a.affectedComponents);
      expect(b.primarySymptom).toEqual(a.primarySymptom);
      expect(b.secondarySymptoms).toEqual(a.secondarySymptoms);
      expect({ ...b, scenario: { ...b.scenario, seed: 42 }, faultParameters: {} }).toEqual({
        ...a,
        faultParameters: {},
      });
    }
    expect(buildGroundTruth('poison-order', 7).faultParameters).toEqual({
      poisonSku: poisonSku(7),
    });
    expect(buildGroundTruth('payment-timeouts', 7).faultParameters).toEqual(
      buildGroundTruth('payment-timeouts', 42).faultParameters,
    );
  });

  it('every symptom names an M3 catalog metric and only its label keys, plus job', () => {
    for (const name of SCENARIO_NAMES) {
      const truth = buildGroundTruth(name, 42);
      for (const symptom of [truth.primarySymptom, ...truth.secondarySymptoms]) {
        const allowed = CATALOG[symptom.metric];
        expect(allowed, `${name}: ${symptom.metric}`).toBeDefined();
        expect(instrumentFor[symptom.metric]).toBeDefined();
        for (const key of Object.keys(symptom.matchers)) {
          expect(['job', ...(allowed ?? [])], `${name}: ${key}`).toContain(key);
        }
        expect(['orders-api', 'worker']).toContain(symptom.matchers.job);
      }
    }
  });

  it('every scenario has a definition, processes, and the 30 s / 90 s timeline', () => {
    for (const name of SCENARIO_NAMES) {
      expect(SCENARIOS[name].name).toBe(name);
      expect(SCENARIOS[name].processes.length).toBeGreaterThan(0);
      expect(buildGroundTruth(name, 1).timeline).toEqual({
        triggerOffsetMs: 30000,
        durationMs: 90000,
      });
    }
    expect(buildGroundTruth('api-pool-exhaustion', 42).affectedComponents).toEqual([
      'orders-api',
      'orders-api-pool',
    ]);
  });
});
