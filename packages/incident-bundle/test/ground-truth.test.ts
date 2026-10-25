import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  groundTruthSchema,
  jsonSchemaText,
  parseGroundTruth,
  SCHEMA_VERSION,
} from '../src/index.js';

/** M5a criterion A7: the ground-truth schema, its JSON Schema file and canonical JSON. */
const SCHEMA_FILE = new URL(
  '../../../docs/schemas/incident-bundle/v1/ground-truth.schema.json',
  import.meta.url,
);

const condition = {
  signal: 'metric',
  metric: 'commerce_payment_calls_total',
  matchers: { job: 'worker', payment_result: 'error' },
  evaluation: 'increase',
  windowSeconds: 60,
  comparison: 'gt',
  threshold: 0,
  deadlineSeconds: 120,
  description: 'Charges fail.',
};
const valid = {
  schemaVersion: SCHEMA_VERSION,
  scenario: { name: 'payment-timeouts', version: 1, seed: 42 },
  description: 'A description.',
  rootCause: { component: 'payment-provider', summary: 'A summary.' },
  affectedComponents: ['payment-provider', 'worker'],
  faultParameters: { hangPercent: 60, operation: 'charge', flag: true },
  timeline: { triggerOffsetMs: 30000, durationMs: 90000 },
  primarySymptom: condition,
  secondarySymptoms: [],
  dataEffects: ['An effect.'],
  expectedRemediation: ['A step.'],
};

describe('ground-truth schema v1 (A7)', () => {
  it('accepts a valid document, and extra fields, as 1.x consumers must', () => {
    expect(parseGroundTruth(valid)).toMatchObject({ scenario: { name: 'payment-timeouts' } });
    expect(() => parseGroundTruth({ ...valid, addedInMinor: 'x' })).not.toThrow();
    expect(() => parseGroundTruth({ ...valid, schemaVersion: '1.4.0' })).not.toThrow();
  });

  it('rejects each kind of invalid document', () => {
    const bad: [string, unknown][] = [
      ['missing field', { ...valid, rootCause: undefined }],
      ['major 2', { ...valid, schemaVersion: '2.0.0' }],
      ['bad identifier', { ...valid, scenario: { ...valid.scenario, name: 'Payment_Timeouts' } }],
      ['seed above uint32', { ...valid, scenario: { ...valid.scenario, seed: 2 ** 32 } }],
      ['unsorted components', { ...valid, affectedComponents: ['worker', 'payment-provider'] }],
      ['duplicate components', { ...valid, affectedComponents: ['worker', 'worker'] }],
      ['no components', { ...valid, affectedComponents: [] }],
      ['bad evaluation', { ...valid, primarySymptom: { ...condition, evaluation: 'rate' } }],
      ['bad comparison', { ...valid, primarySymptom: { ...condition, comparison: 'eq' } }],
      ['bad label key', { ...valid, primarySymptom: { ...condition, matchers: { 'a.b': 'x' } } }],
      ['no remediation', { ...valid, expectedRemediation: [] }],
      ['nested parameter', { ...valid, faultParameters: { a: { b: 1 } } }],
    ];
    for (const [label, doc] of bad) {
      expect(() => parseGroundTruth(doc), label).toThrow();
    }
  });

  it('the committed JSON Schema file matches the Zod schema (drift test)', () => {
    const expected = jsonSchemaText('ground-truth.schema.json');
    if (process.env.WRITE_SCHEMAS === '1') writeFileSync(SCHEMA_FILE, expected);
    expect(readFileSync(SCHEMA_FILE, 'utf8')).toBe(expected);
    const schema = JSON.parse(expected) as Record<string, unknown>;
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    // Loose objects: consumers on an older 1.x schema accept newer 1.x documents.
    expect(schema.additionalProperties).toEqual({});
    expect(groundTruthSchema).toBeDefined();
  });
});

describe('canonical JSON', () => {
  it('sorts keys at every level, keeps array order, indents by two spaces and ends with a newline', () => {
    const text = canonicalJson({ b: 1, a: { d: [3, 1], c: undefined, b: null } });
    expect(text).toBe(
      '{\n  "a": {\n    "b": null,\n    "d": [\n      3,\n      1\n    ]\n  },\n  "b": 1\n}\n',
    );
    expect(canonicalJson({ y: 1, x: 2 })).toBe(canonicalJson({ x: 2, y: 1 }));
  });
});
