import {
  canonicalJson,
  parseGroundTruth,
  SCHEMA_VERSION,
  type GroundTruth,
} from '@commerce/incident-bundle';
import {
  DEFAULT_DURATION_MS,
  SCENARIOS,
  TRIGGER_OFFSET_MS,
  type ScenarioName,
} from './scenarios.js';

/**
 * Ground truth for a scenario and seed: a pure function of the scenario name, its version, the
 * seed and the schema version. No timestamps, run ids, order ids or producer commit.
 */
export function buildGroundTruth(name: ScenarioName, seed: number): GroundTruth {
  const scenario = SCENARIOS[name];
  return parseGroundTruth({
    schemaVersion: SCHEMA_VERSION,
    scenario: { name: scenario.name, version: scenario.version, seed },
    description: scenario.description,
    rootCause: scenario.rootCause,
    affectedComponents: [...scenario.affectedComponents].sort(),
    faultParameters: scenario.faultParameters(seed),
    timeline: { triggerOffsetMs: TRIGGER_OFFSET_MS, durationMs: DEFAULT_DURATION_MS },
    primarySymptom: scenario.primarySymptom,
    secondarySymptoms: scenario.secondarySymptoms,
    dataEffects: scenario.dataEffects,
    expectedRemediation: scenario.expectedRemediation,
  });
}

/** The exact bytes of `ground_truth.json` for a scenario and seed. */
export function groundTruthJson(name: ScenarioName, seed: number): string {
  return canonicalJson(buildGroundTruth(name, seed));
}
