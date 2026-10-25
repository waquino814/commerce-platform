import { z } from 'zod';
import {
  identifier,
  PROMETHEUS_LABEL,
  PROMETHEUS_NAME,
  schemaVersion1,
  text,
  uint32,
} from './formats.js';

/**
 * Incident bundle schema version 1: the ground-truth document (ADR 0007,
 * docs/prompts/m5-design.md, "Ground-truth contract"). Objects are loose, so a consumer validating
 * with an older 1.x schema still accepts a newer 1.x document. Scenario names and component
 * identifiers are open strings, not closed enumerations.
 */
export const SCHEMA_VERSION = '1.0.0';

/** A metric condition, rendered by consumers for their own backend. */
export const conditionSchema = z.looseObject({
  signal: z.literal('metric'),
  /** Prometheus name, as produced by the collector's translation. */
  metric: z.string().regex(PROMETHEUS_NAME),
  /** Exact-equality label matchers. */
  matchers: z.record(z.string().regex(PROMETHEUS_LABEL), z.string()),
  evaluation: z.enum(['increase', 'max_over_time']),
  windowSeconds: z.number().int().positive(),
  comparison: z.enum(['gt', 'gte', 'lt', 'lte']),
  threshold: z.number(),
  deadlineSeconds: z.number().int().positive(),
  description: text,
});

export const groundTruthSchema = z.looseObject({
  schemaVersion: schemaVersion1,
  scenario: z.looseObject({
    name: identifier,
    version: z.number().int().positive(),
    seed: uint32,
  }),
  description: text,
  rootCause: z.looseObject({ component: identifier, summary: text }),
  affectedComponents: z.array(identifier).min(1),
  faultParameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  timeline: z.looseObject({
    triggerOffsetMs: z.number().int().min(0),
    durationMs: z.number().int().positive(),
  }),
  primarySymptom: conditionSchema,
  secondarySymptoms: z.array(conditionSchema),
  dataEffects: z.array(text),
  expectedRemediation: z.array(text).min(1),
});

export type Condition = z.infer<typeof conditionSchema>;
export type GroundTruth = z.infer<typeof groundTruthSchema>;

/**
 * Validates a ground-truth document. Beyond the shape, `affectedComponents` must be sorted and
 * unique, as the canonical form requires.
 */
export function parseGroundTruth(value: unknown): GroundTruth {
  const parsed = groundTruthSchema.parse(value);
  const components = parsed.affectedComponents;
  const sortedUnique = [...new Set(components)].sort();
  if (JSON.stringify(sortedUnique) !== JSON.stringify(components)) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['affectedComponents'],
        message: 'must be sorted and unique',
        input: components,
      },
    ]);
  }
  return parsed;
}
