import { z } from 'zod';
import { ConfigError, databaseUrlSchema, parseEnv } from '../config.js';
import { runMigrations } from '../migrate.js';
import { createPool } from '../pool.js';

const schema = z.object({ DATABASE_URL: databaseUrlSchema });

async function main(): Promise<void> {
  const config = parseEnv(schema, process.env);
  const pool = createPool({ connectionString: config.DATABASE_URL, max: 1 }, (err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'idle client error', err: err.message }));
  });
  try {
    const applied = await runMigrations(pool);
    console.log(
      JSON.stringify({ level: 'info', msg: 'migrations complete', applied, count: applied.length }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const message =
    err instanceof ConfigError
      ? err.message
      : String(err instanceof Error ? (err.cause ?? err) : err);
  console.error(JSON.stringify({ level: 'fatal', msg: 'migration failed', err: message }));
  process.exit(1);
});
