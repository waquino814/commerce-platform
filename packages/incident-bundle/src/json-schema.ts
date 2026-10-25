import { z } from 'zod';
import { canonicalJson } from './canonical.js';
import { groundTruthSchema, SCHEMA_VERSION } from './ground-truth.js';

/**
 * The committed JSON Schema files, generated from the Zod schemas (ADR 0007). Consumers, such as
 * the Engineering Operations AI repository, vendor these files; they never import this package.
 */
export const JSON_SCHEMA_FILES = {
  'ground-truth.schema.json': () =>
    withId(z.toJSONSchema(groundTruthSchema, { target: 'draft-2020-12' }), 'ground-truth'),
} as const;

function withId(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  return {
    ...schema,
    $id: `https://commerce-platform.local/schemas/incident-bundle/v1/${name}.schema.json`,
    title: `Incident bundle ${name} (schema ${SCHEMA_VERSION})`,
  };
}

/** The exact text of a committed JSON Schema file. */
export function jsonSchemaText(file: keyof typeof JSON_SCHEMA_FILES): string {
  return canonicalJson(JSON_SCHEMA_FILES[file]());
}
