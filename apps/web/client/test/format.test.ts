import { describe, expect, it } from 'vitest';
import { formatBytes, formatMs, formatTime, renderCondition } from '../src/format';
import { matchRoute } from '../src/router';

describe('format helpers', () => {
  it('formats durations, times and sizes without inventing values', () => {
    expect([formatMs(null), formatMs(undefined), formatMs(412.4), formatMs(65_005)]).toEqual([
      '—',
      '—',
      '412 ms',
      '65.0 s',
    ]);
    expect([
      formatTime(null),
      formatTime('2026-10-26T01:56:35.005Z'),
      formatTime('not a time'),
    ]).toEqual(['—', '2026-10-26 01:56:35 UTC', 'not a time']);
    expect([
      formatBytes(null),
      formatBytes(512),
      formatBytes(2048),
      formatBytes(3 * 1024 ** 2),
    ]).toEqual(['missing', '512 B', '2.0 KB', '3.0 MB']);
  });

  it('renders conditions as the incident CLI does', () => {
    const c = {
      metric: 'm',
      matchers: { b: '2', a: '1' },
      evaluation: 'increase',
      windowSeconds: 60,
      comparison: 'gt',
      threshold: 0,
    };
    expect(renderCondition(c)).toBe('sum(increase(m{a="1", b="2"}[60s])) > 0');
    expect(
      renderCondition({ ...c, evaluation: 'max_over_time', comparison: 'gte', threshold: 2 }),
    ).toBe('max(max_over_time(m{a="1", b="2"}[60s])) >= 2');
    expect(renderCondition({ ...c, comparison: 'eq' })).toBe(
      'sum(increase(m{a="1", b="2"}[60s])) eq 0',
    );
  });

  it('matches routes', () => {
    expect(matchRoute('/')).toEqual({ name: 'incidents' });
    expect(matchRoute('')).toEqual({ name: 'incidents' });
    expect(matchRoute('/health')).toEqual({ name: 'health' });
    expect(matchRoute('/incidents/a%20b')).toEqual({ name: 'incident', id: 'a b' });
    expect(matchRoute('/incidents/a/b')).toEqual({ name: 'not_found' });
  });
});
