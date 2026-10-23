import { databaseUrlSchema, parseEnv } from '@commerce/db';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: databaseUrlSchema,
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface Config {
  databaseUrl: string;
  port: number;
  logLevel: z.infer<typeof schema>['LOG_LEVEL'];
}

/** Reads and validates configuration. Throws ConfigError naming every invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = parseEnv(schema, env);
  return { databaseUrl: parsed.DATABASE_URL, port: parsed.PORT, logLevel: parsed.LOG_LEVEL };
}
