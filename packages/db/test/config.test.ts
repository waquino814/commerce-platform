import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, databaseUrlSchema, parseEnv } from '../src/index.js';

describe('databaseUrlSchema', () => {
  it.each(['postgres://u:p@h:5432/db', 'postgresql://h/db'])('accepts %s', (url) => {
    expect(databaseUrlSchema.parse(url)).toBe(url);
  });

  it.each(['not-a-url', 'mysql://h/db', 'http://h/db', ''])('rejects %j', (url) => {
    expect(databaseUrlSchema.safeParse(url).success).toBe(false);
  });
});

describe('parseEnv', () => {
  it('names every invalid variable in one ConfigError', () => {
    const schema = z.object({ A: z.string(), B: z.coerce.number() });
    expect(() => parseEnv(schema, { B: 'x' })).toThrow(ConfigError);
    expect(() => parseEnv(schema, { B: 'x' })).toThrow(/A: .*; B: /);
  });
});
