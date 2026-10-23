import { afterAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createTestPool, UNREACHABLE_DATABASE_URL } from '../../../packages/db/test/support.js';
import { buildHealthServer } from '../src/health-server.js';

const logger = pino({ level: 'silent' });

describe('worker health endpoints', () => {
  const reachable = createTestPool();
  const unreachable = createTestPool(UNREACHABLE_DATABASE_URL);
  const up = buildHealthServer({ pool: reachable, logger });
  const down = buildHealthServer({ pool: unreachable, logger });
  afterAll(async () => {
    await Promise.all([up.close(), down.close()]);
    await Promise.all([reachable.end(), unreachable.end()]);
  });

  it('GET /healthz returns 200 regardless of the database', async () => {
    expect((await up.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await down.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('GET /readyz returns 200 with a reachable database and 503 without', async () => {
    expect((await up.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    expect((await down.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  });
});
