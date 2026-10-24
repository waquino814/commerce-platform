import type { DiagLogger } from '@opentelemetry/api';

export interface DiagLine {
  level: 'warn' | 'error';
  /** The message with urls, ids and numbers removed: stable across repeats of the same failure. */
  kind: string;
  msg: string;
  /** Messages of this kind dropped since the previous emitted line. */
  suppressed: number;
}

export interface RateLimitedDiagLogger extends DiagLogger {
  /** Total messages received, emitted or not. Used by tests. */
  readonly received: number;
}

/** Normalizes a diagnostic message into its kind, so repeats of one failure share a kind. */
export function messageKind(msg: string): string {
  return msg
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ')
    .slice(0, 2000);
}

/**
 * An OpenTelemetry DiagLogger that emits at most one line per message kind per window, and counts
 * what it suppressed in between. A long collector outage produces about one line per minute per
 * kind instead of a flood. Only warn and error are handled; the SDK runs at DiagLogLevel.WARN.
 */
export function createRateLimitedDiagLogger(options: {
  emit: (line: DiagLine) => void;
  now?: () => number;
  windowMs?: number;
}): RateLimitedDiagLogger {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? 60_000;
  const state = new Map<string, { lastEmitAt: number; suppressed: number }>();
  let received = 0;

  const log = (level: DiagLine['level'], args: unknown[]): void => {
    received += 1;
    const msg = format(args);
    const kind = `${level}:${messageKind(msg)}`;
    const t = now();
    const entry = state.get(kind);
    if (entry && t - entry.lastEmitAt < windowMs) {
      entry.suppressed += 1;
      return;
    }
    options.emit({ level, kind, msg, suppressed: entry?.suppressed ?? 0 });
    state.set(kind, { lastEmitAt: t, suppressed: 0 });
  };

  return {
    get received() {
      return received;
    },
    error: (...args: unknown[]) => {
      log('error', args);
    },
    warn: (...args: unknown[]) => {
      log('warn', args);
    },
    info: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };
}
