import { parseEnv } from '@commerce/db/config';
import { z } from 'zod';

const schema = z.object({
  ORDERS_API_URL: z
    .url({ protocol: /^https?$/, error: 'must be an http:// or https:// URL' })
    .default('http://localhost:3000'),
});

export interface LoadgenConfig {
  /** The orders API: the load generator's only target. */
  readonly ordersApiUrl: string;
}

/** Validates the environment and throws ConfigError naming the variable. */
export function loadConfig(env: NodeJS.ProcessEnv): LoadgenConfig {
  const parsed = parseEnv(schema, env);
  return { ordersApiUrl: parsed.ORDERS_API_URL.replace(/\/+$/, '') };
}
