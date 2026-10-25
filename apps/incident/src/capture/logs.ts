import type { LogsRecord } from '@commerce/incident-bundle';
import { ADMIN_PATH_PREFIX } from '@commerce/telemetry';
import { isAdminPath, type CaptureWindow, type RunCommand } from './deps.js';

/**
 * Log capture (docs/prompts/m5-design.md, "Log capture and normalization"): one
 * `docker compose logs --no-log-prefix --timestamps --since --until <service>` per service, each
 * line normalized from the apps' pino JSON. Lines that are not JSON objects are kept as plain
 * messages. Records for `/admin` requests are dropped, as a second guard.
 */
const PINO_LEVELS: Readonly<Record<number, LogsRecord['level']>> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};
const RESERVED = new Set(['level', 'time', 'msg', 'service', 'trace_id', 'span_id']);
const DOCKER_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2}) (.*)$/;
/** Fastify's default request IDs: a per-process counter, `req-1`, `req-2`, and so on, in base 36. */
const FASTIFY_REQ_ID = /^req-([0-9a-z]+)$/;

export interface LogsCapture {
  records: LogsRecord[];
  summary: {
    source: 'docker-compose';
    services: { name: string; records: number; nonJsonLines: number; droppedAdminLines: number }[];
  };
}

export async function captureLogs(
  options: CaptureWindow & { services: readonly string[]; runCommand: RunCommand },
): Promise<LogsCapture> {
  const records: LogsRecord[] = [];
  const services: LogsCapture['summary']['services'] = [];
  for (const service of [...options.services].sort()) {
    const args = [
      'compose',
      'logs',
      '--no-log-prefix',
      '--timestamps',
      '--since',
      options.captureFrom.toISOString(),
      '--until',
      options.captureTo.toISOString(),
      service,
    ];
    const result = await options.runCommand('docker', args);
    if (result.exitCode !== 0) {
      throw new Error(
        `docker compose logs for ${service} failed with exit code ${String(result.exitCode)}: ${result.stderr.trim()}`,
      );
    }
    const normalized = normalizeLogs(service, result.stdout, options.captureFrom);
    records.push(...normalized.records);
    services.push({
      name: service,
      records: normalized.records.length,
      nonJsonLines: normalized.nonJsonLines,
      droppedAdminLines: normalized.droppedAdminLines,
    });
  }
  return { records, summary: { source: 'docker-compose', services } };
}

/** Normalizes one service's `docker compose logs --timestamps` output. */
export function normalizeLogs(
  service: string,
  stdout: string,
  fallbackTime: Date,
): { records: LogsRecord[]; nonJsonLines: number; droppedAdminLines: number } {
  const records: LogsRecord[] = [];
  let nonJsonLines = 0;
  let droppedAdminLines = 0;
  let lastTime = fallbackTime.toISOString();
  const links = new RequestLinks();
  for (const raw of stdout.split('\n')) {
    if (raw.trim() === '') continue;
    const stamped = DOCKER_TIMESTAMP.exec(raw);
    const dockerTime = stamped ? dockerIso(stamped) : undefined;
    const line = stamped ? (stamped[4] ?? '') : raw;
    if (dockerTime) lastTime = dockerTime;

    const value = parseObject(line);
    if (!value) {
      nonJsonLines += 1;
      records.push({
        service,
        time: dockerTime ?? lastTime,
        level: 'unknown',
        message: line,
        attributes: {},
      });
      continue;
    }
    if (links.drop(value)) {
      droppedAdminLines += 1;
      continue;
    }
    records.push(normalizeObject(service, value, dockerTime ?? lastTime));
  }
  // Time order, stable for equal times.
  const ordered = records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.time < b.r.time ? -1 : a.r.time > b.r.time ? 1 : a.i - b.i))
    .map(({ r }) => r);
  return { records: ordered, nonJsonLines, droppedAdminLines };
}

function normalizeObject(
  service: string,
  value: Record<string, unknown>,
  fallbackTime: string,
): LogsRecord {
  const level = typeof value.level === 'number' ? PINO_LEVELS[value.level] : undefined;
  const attributes: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) if (!RESERVED.has(key)) attributes[key] = v;
  if (!level && value.level !== undefined) attributes.pinoLevel = value.level;
  const time =
    typeof value.time === 'number' && Number.isFinite(value.time)
      ? (safeIso(value.time) ?? fallbackTime)
      : fallbackTime;
  const record: LogsRecord = {
    service,
    time,
    level: level ?? 'unknown',
    message: typeof value.msg === 'string' ? value.msg : '',
    attributes,
  };
  if (typeof value.trace_id === 'string' && /^[0-9a-f]{32}$/.test(value.trace_id)) {
    record.trace_id = value.trace_id;
  } else if (value.trace_id !== undefined) {
    attributes.trace_id = value.trace_id;
  }
  if (typeof value.span_id === 'string' && /^[0-9a-f]{16}$/.test(value.span_id)) {
    record.span_id = value.span_id;
  } else if (value.span_id !== undefined) {
    attributes.span_id = value.span_id;
  }
  return record;
}

/**
 * Links Fastify's follow-up records to a dropped `/admin` request through `reqId`, only where the
 * link is reliable. `reqId` is a per-process counter, so a link holds within one container
 * lifetime: it ends at the next "incoming request" with the same `reqId`, or when the counter
 * starts over, which marks a restart. A record whose link cannot be established is kept.
 */
class RequestLinks {
  private readonly dropped = new Set<string>();
  private lastCounter = -1;

  drop(value: Record<string, unknown>): boolean {
    const req = value.req as { url?: unknown } | undefined;
    const reqId = typeof value.reqId === 'string' ? value.reqId : undefined;
    const counter = reqId === undefined ? undefined : counterOf(reqId);
    const isIncoming = req !== undefined && typeof req === 'object' && 'url' in req;
    if (isIncoming) {
      if (counter !== undefined) {
        // Within one process the counter only grows. If it does not, the process restarted, so
        // no earlier link holds any more.
        if (counter <= this.lastCounter) this.dropped.clear();
        this.lastCounter = counter;
      }
      const admin = isAdminPath(req.url, ADMIN_PATH_PREFIX);
      if (reqId !== undefined && counter !== undefined) {
        if (admin) this.dropped.add(reqId);
        else this.dropped.delete(reqId);
      }
      return admin;
    }
    return reqId !== undefined && counter !== undefined && this.dropped.has(reqId);
  }
}

function counterOf(reqId: string): number | undefined {
  const match = FASTIFY_REQ_ID.exec(reqId);
  if (!match?.[1]) return undefined;
  const n = parseInt(match[1], 36);
  return Number.isSafeInteger(n) ? n : undefined;
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function dockerIso(match: RegExpExecArray): string | undefined {
  const fraction = (match[2] ?? '.000').slice(0, 4).padEnd(4, '0');
  return safeIso(Date.parse(`${match[1] ?? ''}${fraction}${match[3] ?? ''}`));
}

function safeIso(ms: number): string | undefined {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
