import { seedCatalog } from '@commerce/db';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestPool,
  resetDatabase,
  testDatabaseUrl,
} from '../../../packages/db/test/support.js';
import { buildServer } from '../../orders-api/src/server.js';
import { createLoadGenerator } from '../src/index.js';
import { STEADY, type Profile } from '../src/profiles.js';

/**
 * M4 criterion 9: a short real-time run against the orders API built in-process, on the isolated
 * test database. No worker runs, so orders stay pending and no stock is reserved.
 */
const TEST_DATABASE = 'commerce_test';

/** Refuses to touch anything but the test database: never the Compose `commerce` database. */
function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (name !== TEST_DATABASE) {
    throw new Error(
      `refusing to reset or seed database "${name}": the functional test only uses ${TEST_DATABASE}`,
    );
  }
}

/** 2 s at 20 rps: 40 entries, no warm-up, otherwise the steady profile's rules. */
const FUNCTIONAL: Profile = Object.freeze({
  ...STEADY,
  name: 'functional',
  ratePerSecond: 20,
  durationMs: 2_000,
  warmupMs: 0,
});

describe('functional run against the in-process API (criterion 9)', () => {
  const url = testDatabaseUrl();
  assertTestDatabase(url);
  const pool = createTestPool(url);
  const app = buildServer({ pool, logger: pino({ level: 'silent' }) });
  let baseUrl = '';

  beforeAll(async () => {
    assertTestDatabase(url);
    await resetDatabase(pool);
    await seedCatalog(pool);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no listening port');
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('refuses any database other than commerce_test', () => {
    expect(() => {
      assertTestDatabase('postgres://commerce:x@localhost:5432/commerce');
    }).toThrow(/refusing to reset or seed database "commerce"/);
    expect(() => {
      assertTestDatabase(url);
    }).not.toThrow();
  });

  it('every sent request gets its expected status, and created orders exist and can be read back', async () => {
    const generator = createLoadGenerator({ profile: FUNCTIONAL, seed: 42, baseUrl });
    expect(generator.plan.entries).toHaveLength(40);

    const run = await generator.run();

    // The preflight passed against the freshly seeded test catalog.
    expect(run.preflight.passed).toBe(true);
    expect(run.preflight.catalog).toEqual({ products: 1000, missingSkus: [] });
    const { report, results } = run;
    if (!report || !results) throw new Error('the run did not happen');

    // Every entry has exactly one outcome; every sent request got its expected status.
    expect(report.offered).toBe(40);
    expect(report.offered).toBe(report.sent + report.missed + report.skipped);
    expect(report.failed).toBe(0);
    expect(report.failedStatuses).toEqual({});
    expect(report.sent).toBeGreaterThan(0);

    // No replays or conflicts: every successful create made one new order with this run's key.
    const creates = report.byOperation['order.create'].successful;
    expect(creates).toBeGreaterThan(0);
    const stored = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM orders WHERE idempotency_key LIKE $1`,
      [`${run.runPrefix}-%`],
    );
    expect(Number(stored.rows[0]?.count)).toBe(creates);

    // Reads of those orders returned 200.
    const reads = report.byOperation['order.read'];
    expect(reads.failed).toBe(0);
    expect(reads.offered).toBe(reads.successful + reads.skipped + reads.missed);
  });
});
