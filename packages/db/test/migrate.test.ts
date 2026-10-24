import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createTestPool } from './support.js';

const ALL = [
  '001_orders.sql',
  '002_catalog_and_order_processing.sql',
  '003_order_trace_context.sql',
];

describe('runMigrations', () => {
  const pool = createTestPool();
  afterAll(() => pool.end());

  it('applies every migration once on an empty schema and nothing on a second run', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    expect(await runMigrations(pool)).toEqual(ALL);
    expect(await runMigrations(pool)).toEqual([]);

    const recorded = await pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(recorded.rows.map((r) => r.name)).toEqual(ALL);
  });

  it('serializes concurrent runners so each migration applies exactly once', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    const results = await Promise.all([runMigrations(pool), runMigrations(pool)]);

    expect(results.flat().sort()).toEqual(ALL);
  });

  it('enforces the order status constraint', async () => {
    await expect(
      pool.query(`INSERT INTO orders (total_cents, currency, status) VALUES (1, 'USD', 'shipped')`),
    ).rejects.toThrow(/orders_status_check/);
  });

  it('fails M1 orders that have no items when migrating an M1 database', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const m1Only = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(`${process.env.TMPDIR ?? '/tmp'}/m1-`),
    );
    const { copyFile } = await import('node:fs/promises');
    const { MIGRATIONS_DIR } = await import('../src/index.js');
    await copyFile(`${MIGRATIONS_DIR}/001_orders.sql`, `${m1Only}/001_orders.sql`);
    await runMigrations(pool, m1Only);
    await pool.query(`INSERT INTO orders (total_cents, currency) VALUES (100, 'USD')`);
    await pool.query(
      `INSERT INTO orders (total_cents, currency, status, claimed_by, claimed_at, processing_attempts)
       VALUES (200, 'USD', 'processing', 'm1-worker', now(), 1)`,
    );

    expect(await runMigrations(pool)).toEqual(ALL.slice(1));

    const rows = await pool.query<{ status: string; failure_reason: string; claimed_by: null }>(
      'SELECT status, failure_reason, claimed_by FROM orders',
    );
    expect(rows.rows).toEqual([
      { status: 'failed', failure_reason: 'invalid_order', claimed_by: null },
      { status: 'failed', failure_reason: 'invalid_order', claimed_by: null },
    ]);
  });
});
