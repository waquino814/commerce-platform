import { describe, expect, it } from 'vitest';
import { probeLogLevel } from '../src/health.js';

describe('probeLogLevel', () => {
  it.each([
    ['info', 'warn'],
    ['debug', 'warn'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['silent', 'silent'],
  ])('app level %s logs probes at %s', (app, expected) => {
    expect(probeLogLevel(app)).toBe(expected);
  });
});
