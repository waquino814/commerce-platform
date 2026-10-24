import { describe, expect, it } from 'vitest';
import { createRateLimitedDiagLogger, messageKind, type DiagLine } from '../src/diag.js';

describe('messageKind', () => {
  it('maps repeats of one failure to one kind', () => {
    expect(messageKind('Error: connect ECONNREFUSED 127.0.0.1:4318')).toBe(
      messageKind('Error: connect ECONNREFUSED 10.0.0.7:49152'),
    );
    expect(messageKind('export to http://otel-collector:4318/v1/traces failed')).toBe(
      'export to <url> failed',
    );
  });
});

describe('rate-limited diag logger (criterion 16, diagnostic rate limiting)', () => {
  it('emits at most one line per kind per minute over a 10-minute outage, with suppressed counts', () => {
    let clock = 0;
    const lines: (DiagLine & { at: number })[] = [];
    const logger = createRateLimitedDiagLogger({
      emit: (line) => lines.push({ ...line, at: clock }),
      now: () => clock,
    });

    // 1,000 diagnostics of two kinds, evenly over a simulated 10 minutes.
    for (let i = 0; i < 1000; i++) {
      clock = i * 600; // 600 ms apart: 1000 * 600 ms = 10 minutes
      if (i % 2 === 0) logger.error(`Error: connect ECONNREFUSED 127.0.0.1:${4000 + i}`);
      else logger.error('PeriodicExportingMetricReader: metrics export timed out after 3000ms');
    }

    expect(logger.received).toBe(1000);
    expect(lines.length).toBeLessThanOrEqual(22);
    for (let minute = 0; minute < 10; minute++) {
      const inMinute = lines.filter((l) => l.at >= minute * 60_000 && l.at < (minute + 1) * 60_000);
      expect(inMinute.length).toBeLessThanOrEqual(2);
    }
    const byKind = Map.groupBy(lines, (l) => l.kind);
    expect(byKind.size).toBe(2);
    for (const kindLines of byKind.values()) {
      expect(kindLines[0]?.suppressed).toBe(0);
      // 500 messages of this kind, one every 1.2 s: 50 per minute, so 49 suppressed per window
      // after the first emitted line.
      for (const later of kindLines.slice(1)) expect(later.suppressed).toBe(49);
      expect(kindLines.reduce((n, l) => n + 1 + l.suppressed, 0)).toBeLessThanOrEqual(500);
    }
  });

  it('logs a kind again once the window has passed, and handles warn separately', () => {
    let clock = 0;
    const lines: DiagLine[] = [];
    const logger = createRateLimitedDiagLogger({ emit: (l) => lines.push(l), now: () => clock });
    logger.error('boom 1');
    logger.error('boom 2');
    clock = 59_999;
    logger.error('boom 3');
    clock = 60_000;
    logger.error('boom 4');
    logger.warn('boom 5');
    logger.info('ignored');
    logger.debug('ignored');
    logger.verbose('ignored');
    expect(lines.map((l) => [l.level, l.msg, l.suppressed])).toEqual([
      ['error', 'boom 1', 0],
      ['error', 'boom 4', 2],
      ['warn', 'boom 5', 0],
    ]);
  });

  it('formats errors and objects without throwing', () => {
    const lines: DiagLine[] = [];
    const logger = createRateLimitedDiagLogger({ emit: (l) => lines.push(l) });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.error('failed:', new TypeError('bad'), { a: 1 }, circular);
    expect(lines[0]?.msg).toBe('failed: TypeError: bad {"a":1} [object Object]');
  });
});
