import { createPool, runMigrations } from './packages/db/src/index.js';

/** Fails fast with a clear message when the test database is missing, then migrates it. */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env and run `docker compose up -d --wait postgres`.',
    );
  }
  const pool = createPool({ connectionString: url, max: 1 }, () => undefined);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
