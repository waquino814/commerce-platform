import { createPool, type Pool } from '../src/index.js';

export const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  return url;
}

export function createTestPool(url: string = testDatabaseUrl()): Pool {
  return createPool({ connectionString: url, connectionTimeoutMillis: 1000 }, () => undefined);
}

export async function resetOrders(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE orders');
}

export async function insertPendingOrders(pool: Pool, count: number): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO orders (total_cents, currency)
     SELECT 1000 + n, 'USD' FROM generate_series(1, $1) AS n
     RETURNING id`,
    [count],
  );
  return result.rows.map((r) => r.id);
}
