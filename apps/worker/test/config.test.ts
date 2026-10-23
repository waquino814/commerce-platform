import { hostname } from 'node:os';
import { ConfigError } from '@commerce/db';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = { DATABASE_URL: 'postgres://u:p@localhost:5432/commerce' };

describe('worker loadConfig', () => {
  it('applies defaults, using the hostname as worker id', () => {
    expect(loadConfig(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      workerId: hostname(),
      pollIntervalMs: 1000,
      claimBatchSize: 10,
      healthPort: 3001,
      logLevel: 'info',
    });
  });

  it('accepts overrides', () => {
    expect(
      loadConfig({
        ...valid,
        WORKER_ID: 'worker-7',
        POLL_INTERVAL_MS: '250',
        CLAIM_BATCH_SIZE: '50',
        HEALTH_PORT: '4001',
      }),
    ).toMatchObject({
      workerId: 'worker-7',
      pollIntervalMs: 250,
      claimBatchSize: 50,
      healthPort: 4001,
    });
  });

  it.each([
    [{}, /DATABASE_URL/],
    [{ DATABASE_URL: 'mysql://h/db' }, /DATABASE_URL/],
    [{ ...valid, WORKER_ID: '  ' }, /WORKER_ID/],
    [{ ...valid, POLL_INTERVAL_MS: '0' }, /POLL_INTERVAL_MS/],
    [{ ...valid, CLAIM_BATCH_SIZE: '-1' }, /CLAIM_BATCH_SIZE/],
    [{ ...valid, HEALTH_PORT: '70000' }, /HEALTH_PORT/],
  ])('rejects %j', (env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });
});
