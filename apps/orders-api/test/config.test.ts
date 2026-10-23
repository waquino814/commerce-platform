import { ConfigError } from '@commerce/db';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = { DATABASE_URL: 'postgres://u:p@localhost:5432/commerce' };

describe('orders-api loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      port: 3000,
      logLevel: 'info',
    });
  });

  it('coerces PORT and accepts LOG_LEVEL', () => {
    expect(loadConfig({ ...valid, PORT: '8080', LOG_LEVEL: 'debug' })).toMatchObject({
      port: 8080,
      logLevel: 'debug',
    });
  });

  it.each([
    [{}, /DATABASE_URL/],
    [{ DATABASE_URL: 'not-a-url' }, /DATABASE_URL/],
    [{ ...valid, PORT: '0' }, /PORT/],
    [{ ...valid, PORT: 'abc' }, /PORT/],
    [{ ...valid, LOG_LEVEL: 'loud' }, /LOG_LEVEL/],
  ])('rejects %j', (env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });
});
