import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { z } from 'zod';
import { groundTruthSchema, parseGroundTruth } from './ground-truth.js';
import { jsonlRecordCount, parseJsonl } from './jsonl.js';
import {
  BUNDLE_FILES,
  MANIFEST_FILE,
  manifestSchema,
  type BundleFile,
  type Manifest,
} from './manifest.js';
import {
  logsRecordSchema,
  metricsRecordSchema,
  traceIdsOf,
  traceRecordSchema,
  type TraceRecord,
} from './records.js';

/**
 * Bundle validation (ADR 0007, docs/prompts/m5-design.md, "Bundle documents"): every file exists
 * and matches its schema, line by line for JSONL; the manifest's SHA-256, byte and record counts
 * match the files; the major version is supported; the manifest and the ground truth name the same
 * scenario. Every error names its file and, where there is one, its field.
 */
export const SUPPORTED_MAJOR_VERSIONS: readonly number[] = [1];

export interface BundleError {
  file: string;
  field?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: BundleError[];
}

export function formatBundleError(e: BundleError): string {
  return e.field === undefined ? `${e.file}: ${e.message}` : `${e.file}: ${e.field}: ${e.message}`;
}

const LINE_SCHEMAS = {
  'traces.jsonl': traceRecordSchema,
  'metrics.jsonl': metricsRecordSchema,
  'logs.jsonl': logsRecordSchema,
} as const;

export async function validateBundle(dir: string): Promise<ValidationResult> {
  const errors: BundleError[] = [];
  const contents = new Map<string, Buffer>();
  for (const file of [MANIFEST_FILE, ...BUNDLE_FILES]) {
    try {
      contents.set(file, await readFile(join(dir, file)));
    } catch {
      errors.push({ file, message: 'missing file' });
    }
  }

  const manifest = checkManifest(contents.get(MANIFEST_FILE), errors);
  const groundTruth = checkGroundTruth(contents.get('ground_truth.json'), errors);
  for (const file of ['traces.jsonl', 'metrics.jsonl', 'logs.jsonl'] as const) {
    const data = contents.get(file);
    if (data) checkJsonl(file, data.toString('utf8'), errors);
  }

  if (manifest) {
    if (manifest.bundleId !== basename(dir)) {
      errors.push({
        file: MANIFEST_FILE,
        field: 'bundleId',
        message: `"${manifest.bundleId}" does not match the directory name "${basename(dir)}"`,
      });
    }
    for (const file of BUNDLE_FILES) {
      const data = contents.get(file);
      if (data) checkFileEntry(file, data, manifest, errors);
    }
    manifest.capture.traces.services.forEach((s, i) => {
      if (s.truncated !== s.truncationReasons.length > 0) {
        errors.push({
          file: MANIFEST_FILE,
          field: `capture.traces.services.${String(i)}.truncated`,
          message: 'must be true exactly when truncationReasons is not empty',
        });
      }
    });
    if (groundTruth) {
      for (const key of ['name', 'version', 'seed'] as const) {
        if (manifest.scenario[key] !== groundTruth.scenario[key]) {
          errors.push({
            file: MANIFEST_FILE,
            field: `scenario.${key}`,
            message: `${JSON.stringify(manifest.scenario[key])} does not match ground_truth.json (${JSON.stringify(groundTruth.scenario[key])})`,
          });
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function parseJsonFile(file: string, data: Buffer, errors: BundleError[]): unknown {
  try {
    return JSON.parse(data.toString('utf8')) as unknown;
  } catch {
    errors.push({ file, message: 'malformed JSON' });
    return undefined;
  }
}

function checkManifest(data: Buffer | undefined, errors: BundleError[]): Manifest | undefined {
  if (!data) return undefined;
  const value = parseJsonFile(MANIFEST_FILE, data, errors);
  if (value === undefined) return undefined;
  const version =
    typeof value === 'object' && value !== null && 'schemaVersion' in value
      ? value.schemaVersion
      : undefined;
  const major = typeof version === 'string' ? Number(version.split('.')[0]) : NaN;
  if (typeof version === 'string' && !SUPPORTED_MAJOR_VERSIONS.includes(major)) {
    errors.push({
      file: MANIFEST_FILE,
      field: 'schemaVersion',
      message: `unsupported major version in "${version}"; supported: ${SUPPORTED_MAJOR_VERSIONS.join(', ')}`,
    });
    return undefined;
  }
  return pushIssues(MANIFEST_FILE, manifestSchema.safeParse(value), errors);
}

function checkGroundTruth(data: Buffer | undefined, errors: BundleError[]) {
  if (!data) return undefined;
  const value = parseJsonFile('ground_truth.json', data, errors);
  if (value === undefined) return undefined;
  const parsed = pushIssues('ground_truth.json', groundTruthSchema.safeParse(value), errors);
  if (!parsed) return undefined;
  try {
    return parseGroundTruth(parsed);
  } catch (err) {
    pushIssues('ground_truth.json', { success: false, error: err as z.ZodError }, errors);
    return undefined;
  }
}

function checkJsonl(file: keyof typeof LINE_SCHEMAS, text: string, errors: BundleError[]): void {
  const { lines, errors: lineErrors } = parseJsonl(text);
  for (const e of lineErrors) {
    errors.push({ file, field: `line ${String(e.line)}`, message: 'error' in e ? e.error : '' });
  }
  for (const entry of lines) {
    if (!('value' in entry)) continue;
    const at = `line ${String(entry.line)}`;
    const schema: z.ZodType = LINE_SCHEMAS[file];
    const parsed = pushIssues(file, schema.safeParse(entry.value), errors, at);
    if (parsed !== undefined && file === 'traces.jsonl') {
      const ids = traceIdsOf(parsed as TraceRecord);
      if (ids.length !== 1) {
        errors.push({
          file,
          field: at,
          message: `one trace per line: found ${String(ids.length)} trace IDs`,
        });
      }
    }
  }
}

function checkFileEntry(file: BundleFile, data: Buffer, manifest: Manifest, errors: BundleError[]) {
  const entry = manifest.files[file];
  const sha256 = createHash('sha256').update(data).digest('hex');
  const records = file === 'ground_truth.json' ? 1 : jsonlRecordCount(data.toString('utf8'));
  const checks: [string, unknown, unknown][] = [
    ['sha256', entry.sha256, sha256],
    ['bytes', entry.bytes, data.length],
    ['records', entry.records, records],
  ];
  for (const [field, recorded, actual] of checks) {
    if (recorded !== actual) {
      errors.push({
        file: MANIFEST_FILE,
        field: `files.${file}.${field}`,
        message: `records ${JSON.stringify(recorded)} but ${file} has ${JSON.stringify(actual)}`,
      });
    }
  }
}

function pushIssues<T>(
  file: string,
  result: { success: true; data: T } | { success: false; error: z.ZodError },
  errors: BundleError[],
  prefix?: string,
): T | undefined {
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const path = issue.path.map(String).join('.');
    const field = [prefix, path].filter((p) => p !== undefined && p !== '').join(': ');
    errors.push({ file, ...(field === '' ? {} : { field }), message: issue.message });
  }
  return undefined;
}
