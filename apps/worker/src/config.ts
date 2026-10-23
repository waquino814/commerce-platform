import { hostname } from 'node:os';
import { databaseUrlSchema, parseEnv } from '@commerce/db';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: databaseUrlSchema,
  WORKER_ID: z.string().trim().min(1).optional(),
  POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(1000),
  CLAIM_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(10),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface Config {
  databaseUrl: string;
  workerId: string;
  pollIntervalMs: number;
  claimBatchSize: number;
  healthPort: number;
  logLevel: z.infer<typeof schema>['LOG_LEVEL'];
}

/** Reads and validates configuration. Throws ConfigError naming every invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = parseEnv(schema, env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    workerId: parsed.WORKER_ID ?? hostname(),
    pollIntervalMs: parsed.POLL_INTERVAL_MS,
    claimBatchSize: parsed.CLAIM_BATCH_SIZE,
    healthPort: parsed.HEALTH_PORT,
    logLevel: parsed.LOG_LEVEL,
  };
}
