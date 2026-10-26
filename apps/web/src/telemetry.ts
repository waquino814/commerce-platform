import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { BUNDLE_ID } from '@commerce/incident-bundle';

/**
 * Telemetry derived from one bundle's own files, for the detail view: the primary-symptom series
 * from `metrics.jsonl`, a summary of `logs.jsonl`, and sample traces from `traces.jsonl`. Nothing is
 * queried live: these are the values captured in the bundle. Large files are read as streams.
 */
export interface SymptomTelemetry {
  metric: string;
  matchers: Record<string, string>;
  series: { labels: Record<string, string>; samples: [number, number][] }[];
  triggerStartedAt: string | null;
  triggerStoppedAt: string | null;
  detectedAt: string | null;
}

export interface LogSummary {
  total: number;
  byLevel: Record<string, number>;
  byService: Record<string, number>;
  sampleErrors: { time: string; service: string; message: string; traceId: string | null }[];
}

export interface TraceSample {
  traceId: string;
  rootName: string;
  services: string[];
  spanCount: number;
  durationMs: number;
  startTime: string;
  error: boolean;
}

export interface IncidentTelemetry {
  symptom: SymptomTelemetry | null;
  logs: LogSummary;
  traces: { total: number; samples: TraceSample[] };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const MAX_ERROR_SAMPLES = 5;
const MAX_TRACE_SAMPLES = 20;

async function readJson(path: string): Promise<Json> {
  try {
    const v = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
}

async function* jsonLines(path: string): AsyncGenerator<Json> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const v = JSON.parse(line) as unknown;
        if (isObject(v)) yield v;
      } catch {
        // A malformed line is skipped here; the validator reports it.
      }
    }
  } catch (err) {
    // A missing file has no lines; the validator reports it. Anything else is a real read failure.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function symptom(dir: string, manifest: Json): Promise<SymptomTelemetry | null> {
  const gt = await readJson(join(dir, 'ground_truth.json'));
  const condition = isObject(gt.primarySymptom) ? gt.primarySymptom : null;
  if (!condition || typeof condition.metric !== 'string' || !isObject(condition.matchers))
    return null;
  const metric = condition.metric;
  const matchers: Record<string, string> = {};
  for (const [k, v] of Object.entries(condition.matchers))
    if (typeof v === 'string') matchers[k] = v;
  const series: SymptomTelemetry['series'] = [];
  for await (const record of jsonLines(join(dir, 'metrics.jsonl'))) {
    if (record.name !== metric || !isObject(record.labels) || !Array.isArray(record.samples))
      continue;
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(record.labels)) if (typeof v === 'string') labels[k] = v;
    if (!Object.entries(matchers).every(([k, v]) => labels[k] === v)) continue;
    const samples: [number, number][] = [];
    for (const s of record.samples) {
      if (Array.isArray(s) && typeof s[0] === 'number' && typeof s[1] === 'string') {
        const value = Number(s[1]);
        if (Number.isFinite(value)) samples.push([s[0], value]);
      }
    }
    series.push({ labels, samples });
  }
  const trigger = isObject(manifest.trigger) ? manifest.trigger : {};
  const detection = isObject(manifest.detection) ? manifest.detection : {};
  return {
    metric,
    matchers,
    series,
    triggerStartedAt: typeof trigger.startedAt === 'string' ? trigger.startedAt : null,
    triggerStoppedAt: typeof trigger.stoppedAt === 'string' ? trigger.stoppedAt : null,
    detectedAt: typeof detection.detectedAt === 'string' ? detection.detectedAt : null,
  };
}

async function logs(dir: string): Promise<LogSummary> {
  const summary: LogSummary = { total: 0, byLevel: {}, byService: {}, sampleErrors: [] };
  for await (const r of jsonLines(join(dir, 'logs.jsonl'))) {
    const level = typeof r.level === 'string' ? r.level : 'unknown';
    const service = typeof r.service === 'string' ? r.service : 'unknown';
    summary.total += 1;
    summary.byLevel[level] = (summary.byLevel[level] ?? 0) + 1;
    summary.byService[service] = (summary.byService[service] ?? 0) + 1;
    if (
      (level === 'error' || level === 'fatal') &&
      summary.sampleErrors.length < MAX_ERROR_SAMPLES
    ) {
      summary.sampleErrors.push({
        time: typeof r.time === 'string' ? r.time : '',
        service,
        message: typeof r.message === 'string' ? r.message : '',
        traceId: typeof r.trace_id === 'string' ? r.trace_id : null,
      });
    }
  }
  return summary;
}

function summarizeTrace(record: Json): TraceSample | null {
  if (!Array.isArray(record.resourceSpans)) return null;
  let traceId = '';
  let root: { name: string; start: bigint } | null = null;
  let start: bigint | null = null;
  let end: bigint | null = null;
  let spanCount = 0;
  let error = false;
  const services = new Set<string>();
  for (const rs of record.resourceSpans) {
    if (!isObject(rs)) continue;
    const attributes =
      isObject(rs.resource) && Array.isArray(rs.resource.attributes) ? rs.resource.attributes : [];
    for (const a of attributes) {
      if (
        isObject(a) &&
        a.key === 'service.name' &&
        isObject(a.value) &&
        typeof a.value.stringValue === 'string'
      ) {
        services.add(a.value.stringValue);
      }
    }
    for (const ss of Array.isArray(rs.scopeSpans) ? rs.scopeSpans : []) {
      if (!isObject(ss)) continue;
      for (const span of Array.isArray(ss.spans) ? ss.spans : []) {
        if (!isObject(span) || typeof span.traceId !== 'string') continue;
        spanCount += 1;
        traceId = span.traceId;
        const s =
          typeof span.startTimeUnixNano === 'string' && /^\d+$/.test(span.startTimeUnixNano)
            ? BigInt(span.startTimeUnixNano)
            : null;
        const e =
          typeof span.endTimeUnixNano === 'string' && /^\d+$/.test(span.endTimeUnixNano)
            ? BigInt(span.endTimeUnixNano)
            : null;
        if (s !== null && (start === null || s < start)) start = s;
        if (e !== null && (end === null || e > end)) end = e;
        const isRoot = typeof span.parentSpanId !== 'string' || span.parentSpanId === '';
        if (
          isRoot &&
          typeof span.name === 'string' &&
          s !== null &&
          (root === null || s < root.start)
        )
          root = { name: span.name, start: s };
        if (
          isObject(span.status) &&
          (span.status.code === 2 || span.status.code === 'STATUS_CODE_ERROR')
        )
          error = true;
      }
    }
  }
  if (traceId === '' || start === null) return null;
  return {
    traceId,
    rootName: root?.name ?? '(no root span)',
    services: [...services].sort(),
    spanCount,
    durationMs: end !== null && end >= start ? Number((end - start) / 1_000_000n) : 0,
    startTime: new Date(Number(start / 1_000_000n)).toISOString(),
    error,
  };
}

/** Error traces first, then the earliest others, at most 20; the total counts every trace line. */
async function traces(dir: string): Promise<IncidentTelemetry['traces']> {
  const errors: TraceSample[] = [];
  const others: TraceSample[] = [];
  let total = 0;
  for await (const record of jsonLines(join(dir, 'traces.jsonl'))) {
    total += 1;
    const sample = summarizeTrace(record);
    if (!sample) continue;
    (sample.error ? errors : others).push(sample);
  }
  const byStart = (a: TraceSample, b: TraceSample) => a.startTime.localeCompare(b.startTime);
  const samples = [...errors.sort(byStart), ...others.sort(byStart)].slice(0, MAX_TRACE_SAMPLES);
  return { total, samples };
}

/** The bundle's telemetry, or null when no such bundle directory exists. */
export async function readTelemetry(
  incidentsDir: string,
  bundleId: string,
): Promise<IncidentTelemetry | null> {
  if (!BUNDLE_ID.test(bundleId)) return null;
  const dir = join(incidentsDir, bundleId);
  if (!(await stat(dir).catch(() => null))?.isDirectory()) return null;
  const manifest = await readJson(join(dir, 'manifest.json'));
  const [s, l, t] = await Promise.all([symptom(dir, manifest), logs(dir), traces(dir)]);
  return { symptom: s, logs: l, traces: t };
}
