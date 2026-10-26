import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  BUNDLE_FILES,
  BUNDLE_ID,
  MANIFEST_FILE,
  validateBundle,
  type BundleError,
} from '@commerce/incident-bundle';

/**
 * The dashboard's read model over `INCIDENTS_DIR` (docs/prompts/m5c-design.md, section 6): one
 * summary per bundle directory, validated with the M5b validator, and the `.failed/` evidence
 * directories, which are never bundles. Everything is read from disk; nothing is written.
 */
export const FAILED_DIR = '.failed';
/** The files a bundle may serve, by name. */
export const SERVABLE_FILES: readonly string[] = [MANIFEST_FILE, ...BUNDLE_FILES];

export type DetectionStatus = 'detected' | 'not_detected' | 'unknown';

export interface IncidentSummary {
  bundleId: string;
  scenario: string | null;
  seed: number | null;
  createdAt: string | null;
  detection: { status: DetectionStatus; latencyMs: number | null; deadlineSeconds: number | null };
  primarySymptom: { description: string | null; metric: string | null };
  validation: { valid: boolean; errorCount: number };
  /** Valid, the stop confirmed, and no trace truncation (section 6, "Terms"). */
  complete: boolean;
  traces: { service: string; traces: number; truncated: boolean }[];
}

export interface FailedEvidence {
  directory: string;
  bundleId: string | null;
  stage: string | null;
  category: string | null;
  occurredAt: string | null;
  files: string[];
}

export interface IncidentList {
  directoryExists: boolean;
  incidents: IncidentSummary[];
  failed: FailedEvidence[];
}

export interface IncidentDetail extends IncidentSummary {
  window: Record<string, string> | null;
  trigger: {
    startedAt: string | null;
    stoppedAt: string | null;
    requestedDurationMs: number | null;
  };
  producer: { commit: string | null; dirty: boolean | null };
  groundTruth: {
    description: string | null;
    rootCause: { component: string; summary: string } | null;
    affectedComponents: string[];
    primarySymptom: Condition | null;
    secondarySymptoms: Condition[];
    expectedRemediation: string[];
  };
  validationErrors: BundleError[];
  files: { name: string; bytes: number | null }[];
  sampleTraceIds: string[];
}

interface Condition {
  metric: string;
  matchers: Record<string, string>;
  evaluation: string;
  windowSeconds: number;
  comparison: string;
  threshold: number;
  description: string;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Json => (isObject(v) ? v : {});

async function readJson(path: string): Promise<Json | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function condition(v: unknown): Condition | null {
  if (!isObject(v)) return null;
  const metric = str(v.metric);
  if (metric === null) return null;
  const matchers: Record<string, string> = {};
  for (const [k, value] of Object.entries(obj(v.matchers)))
    if (typeof value === 'string') matchers[k] = value;
  return {
    metric,
    matchers,
    evaluation: str(v.evaluation) ?? '',
    windowSeconds: num(v.windowSeconds) ?? 0,
    comparison: str(v.comparison) ?? '',
    threshold: num(v.threshold) ?? 0,
    description: str(v.description) ?? '',
  };
}

async function summarize(
  dir: string,
  bundleId: string,
): Promise<{ summary: IncidentSummary; manifest: Json; groundTruth: Json; errors: BundleError[] }> {
  const path = join(dir, bundleId);
  const [manifest, groundTruth, validation] = await Promise.all([
    readJson(join(path, MANIFEST_FILE)),
    readJson(join(path, 'ground_truth.json')),
    validateBundle(path),
  ]);
  const m = manifest ?? {};
  const gt = groundTruth ?? {};
  const detection = obj(m.detection);
  const detectedAt = detection.detectedAt;
  const status: DetectionStatus =
    typeof detectedAt === 'string' ? 'detected' : detectedAt === null ? 'not_detected' : 'unknown';
  const traceServices = Array.isArray(obj(obj(m.capture).traces).services)
    ? (obj(obj(m.capture).traces).services as unknown[])
    : [];
  const traces = traceServices.filter(isObject).map((s) => ({
    service: str(s.name) ?? '?',
    traces: num(s.traces) ?? 0,
    truncated: s.truncated === true,
  }));
  const stopped = typeof obj(m.trigger).stoppedAt === 'string';
  const primary = condition(gt.primarySymptom);
  const summary: IncidentSummary = {
    bundleId,
    scenario: str(obj(m.scenario).name) ?? str(obj(gt.scenario).name),
    seed: num(obj(m.scenario).seed) ?? num(obj(gt.scenario).seed),
    createdAt: str(m.createdAt),
    detection: {
      status,
      latencyMs: num(detection.latencyMs),
      deadlineSeconds: num(detection.deadlineSeconds),
    },
    primarySymptom: { description: primary?.description ?? null, metric: primary?.metric ?? null },
    validation: { valid: validation.valid, errorCount: validation.errors.length },
    complete: validation.valid && stopped && traces.every((t) => !t.truncated),
    traces,
  };
  return { summary, manifest: m, groundTruth: gt, errors: validation.errors };
}

async function failedEvidence(dir: string): Promise<FailedEvidence[]> {
  const root = join(dir, FAILED_DIR);
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: FailedEvidence[] = [];
  for (const name of names.sort()) {
    const failure = (await readJson(join(root, name, 'failure.json'))) ?? {};
    const files = await readdir(join(root, name)).catch(() => []);
    out.push({
      directory: name,
      bundleId: str(failure.bundleId),
      stage: str(failure.stage),
      category: str(failure.category),
      occurredAt: str(failure.occurredAt),
      files: files.sort(),
    });
  }
  return out;
}

/** Every bundle directory, newest first, and the failed evidence. Throws only on an unreadable directory. */
export async function listIncidents(dir: string): Promise<IncidentList> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { directoryExists: false, incidents: [], failed: [] };
    throw err;
  }
  const ids = entries.filter((e) => e.isDirectory() && BUNDLE_ID.test(e.name)).map((e) => e.name);
  const incidents = await Promise.all(ids.map(async (id) => (await summarize(dir, id)).summary));
  incidents.sort((a, b) => (b.createdAt ?? b.bundleId).localeCompare(a.createdAt ?? a.bundleId));
  return { directoryExists: true, incidents, failed: await failedEvidence(dir) };
}

/** One bundle in detail, or null when no such bundle directory exists. The ID must match M5b's format. */
export async function readIncident(dir: string, bundleId: string): Promise<IncidentDetail | null> {
  if (!BUNDLE_ID.test(bundleId)) return null;
  const path = join(dir, bundleId);
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) return null;
  const { summary, manifest, groundTruth, errors } = await summarize(dir, bundleId);
  const files = await Promise.all(
    SERVABLE_FILES.map(async (name) => ({
      name,
      bytes: (await stat(join(path, name)).catch(() => null))?.size ?? null,
    })),
  );
  const trigger = obj(manifest.trigger);
  const window = isObject(manifest.window)
    ? Object.fromEntries(
        Object.entries(manifest.window).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      )
    : null;
  const rootCause = obj(groundTruth.rootCause);
  return {
    ...summary,
    window,
    trigger: {
      startedAt: str(trigger.startedAt),
      stoppedAt: str(trigger.stoppedAt),
      requestedDurationMs: num(trigger.requestedDurationMs),
    },
    producer: {
      commit: str(obj(manifest.producer).commit),
      dirty:
        typeof obj(manifest.producer).dirty === 'boolean'
          ? (obj(manifest.producer).dirty as boolean)
          : null,
    },
    groundTruth: {
      description: str(groundTruth.description),
      rootCause:
        str(rootCause.component) !== null && str(rootCause.summary) !== null
          ? { component: str(rootCause.component) ?? '', summary: str(rootCause.summary) ?? '' }
          : null,
      affectedComponents: Array.isArray(groundTruth.affectedComponents)
        ? groundTruth.affectedComponents.filter((c): c is string => typeof c === 'string')
        : [],
      primarySymptom: condition(groundTruth.primarySymptom),
      secondarySymptoms: Array.isArray(groundTruth.secondarySymptoms)
        ? groundTruth.secondarySymptoms.map(condition).filter((c): c is Condition => c !== null)
        : [],
      expectedRemediation: Array.isArray(groundTruth.expectedRemediation)
        ? groundTruth.expectedRemediation.filter((c): c is string => typeof c === 'string')
        : [],
    },
    validationErrors: errors,
    files,
    sampleTraceIds: await sampleTraceIds(join(path, 'traces.jsonl'), 3),
  };
}

/** The trace IDs of the first lines of `traces.jsonl`, read as a stream so the file is not loaded whole. */
export async function sampleTraceIds(path: string, limit: number): Promise<string[]> {
  const ids: string[] = [];
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      // The first span's trace ID; a malformed line simply yields none, and the validator reports it.
      const id = /"traceId":"([0-9a-f]{32})"/.exec(line)?.[1];
      if (id) ids.push(id);
      if (ids.length >= limit) break;
    }
  } catch {
    return ids;
  } finally {
    lines.close();
    stream.destroy();
  }
  return ids;
}
