import { hostname } from 'node:os';
import { ConfigError } from '@commerce/db';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DEFAULT_LIMITS } from './support.js';

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
      concurrency: 5,
      claimTimeoutMs: 60_000,
      dbConnectTimeoutMs: 2000,
      dbStatementTimeoutMs: 2000,
      paymentTimeoutMs: 5000,
      paymentLatencyMs: 50,
      processingBudgetMs: 36_000,
      limits: DEFAULT_LIMITS,
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
        WORKER_CONCURRENCY: '8',
        MAX_CHARGE_ATTEMPTS: '4',
      }),
    ).toMatchObject({
      workerId: 'worker-7',
      pollIntervalMs: 250,
      claimBatchSize: 50,
      healthPort: 4001,
      concurrency: 8,
      limits: { maxChargeAttempts: 4 },
    });
  });

  it.each([
    [{}, /DATABASE_URL/],
    [{ DATABASE_URL: 'mysql://h/db' }, /DATABASE_URL/],
    [{ ...valid, WORKER_ID: '  ' }, /WORKER_ID/],
    [{ ...valid, POLL_INTERVAL_MS: '0' }, /POLL_INTERVAL_MS/],
    [{ ...valid, CLAIM_BATCH_SIZE: '-1' }, /CLAIM_BATCH_SIZE/],
    [{ ...valid, HEALTH_PORT: '70000' }, /HEALTH_PORT/],
    [{ ...valid, WORKER_CONCURRENCY: '0' }, /WORKER_CONCURRENCY/],
  ])('rejects %j', (env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });

  describe('startup validation (criterion 19)', () => {
    it('rejects a claim timeout below 1.5 × the processing budget and shows the budget', () => {
      expect(() => loadConfig({ ...valid, CLAIM_TIMEOUT_MS: '53999' })).toThrow(
        /CLAIM_TIMEOUT_MS: .*= 36000 ms.*at least 54000 ms/,
      );
      expect(loadConfig({ ...valid, CLAIM_TIMEOUT_MS: '54000' }).claimTimeoutMs).toBe(54_000);
      expect(() =>
        loadConfig({ ...valid, PAYMENT_TIMEOUT_MS: '20000', CLAIM_TIMEOUT_MS: '60000' }),
      ).toThrow(/= 66000 ms/);
    });

    it('rejects MAX_CLAIMS not above MAX_CHARGE_ATTEMPTS', () => {
      expect(() => loadConfig({ ...valid, MAX_CLAIMS: '3', MAX_CHARGE_ATTEMPTS: '3' })).toThrow(
        /MAX_CLAIMS: must be greater than MAX_CHARGE_ATTEMPTS/,
      );
    });

    it.each([
      ['RETRY_BASE_DELAY_MS', '99'],
      ['RECONCILIATION_BASE_DELAY_MS', '999'],
      ['PAYMENT_UNKNOWN_RECHECK_MS', '59999'],
    ])('rejects %s below its minimum', (name, value) => {
      expect(() => loadConfig({ ...valid, [name]: value })).toThrow(new RegExp(name));
    });
  });
});
