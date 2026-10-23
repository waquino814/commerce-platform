import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

/** Resolves to packages/db/migrations from both src/ and dist/. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;
// Arbitrary constant so concurrent runners (e.g. several containers) serialize.
const MIGRATION_LOCK_ID = 727_001;

/**
 * Applies pending forward-only SQL migrations in filename order.
 * Each file runs in its own transaction together with its `schema_migrations` record.
 * Returns the names of the migrations applied by this call.
 */
export async function runMigrations(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       text        PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const doneNames = new Set(done.rows.map((r) => r.name));

    for (const file of files) {
      if (doneNames.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed`, { cause: err });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
