import { afterAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createTestPool, UNREACHABLE_DATABASE_URL } from '../../../packages/db/test/support.js';
import { buildServer } from '../src/server.js';

const logger = pino({ level: 'silent' });

describe('orders-api health endpoints', () => {
  const reachable = createTestPool();
  const unreachable = createTestPool(UNREACHABLE_DATABASE_URL);
  const up = buildServer({ pool: reachable, logger });
  const down = buildServer({ pool: unreachable, logger });
  afterAll(async () => {
    await Promise.all([up.close(), down.close()]);
    await Promise.all([reachable.end(), unreachable.end()]);
  });

  it('GET /healthz returns 200 with a reachable database', async () => {
    const res = await up.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /healthz returns 200 even when the database is unreachable', async () => {
    const res = await down.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /readyz returns 200 when the database answers', async () => {
    const res = await up.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('GET /readyz returns 503 when the database is unreachable', async () => {
    const res = await down.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready' });
  });
});
