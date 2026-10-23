import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createTestPool } from './support.js';

describe('runMigrations', () => {
  const pool = createTestPool();
  afterAll(() => pool.end());

  it('applies every migration once on an empty schema and nothing on a second run', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    expect(await runMigrations(pool)).toEqual(['001_orders.sql']);
    expect(await runMigrations(pool)).toEqual([]);

    const recorded = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(recorded.rows.map((r) => r.name)).toEqual(['001_orders.sql']);
  });

  it('serializes concurrent runners so each migration applies exactly once', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    const results = await Promise.all([runMigrations(pool), runMigrations(pool)]);

    expect(results.flat()).toEqual(['001_orders.sql']);
  });

  it('enforces the order status constraint', async () => {
    await expect(
      pool.query(`INSERT INTO orders (total_cents, currency, status) VALUES (1, 'USD', 'shipped')`),
    ).rejects.toThrow(/orders_status_check/);
  });
});
