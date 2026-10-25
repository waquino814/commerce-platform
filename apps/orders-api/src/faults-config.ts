import { ConfigError, parseEnv } from '@commerce/db';
import { z } from 'zod';

/**
 * M5 fault configuration, separate from the main config so M2's config contract is unchanged.
 * Only `FAULTS_ENABLED=true` makes the scenario control endpoints exist; it never starts a
 * scenario. `WORKER_ADMIN_URL` is validated only when faults are enabled.
 */
const schema = z.object({
  FAULTS_ENABLED: z.enum(['true', 'false']).default('false'),
  WORKER_ADMIN_URL: z.string().optional(),
});
const urlSchema = z.url({ protocol: /^https?$/ });

export type FaultsConfig =
  { readonly enabled: false } | { readonly enabled: true; readonly workerAdminUrl: string };

export function loadFaultsConfig(env: NodeJS.ProcessEnv): FaultsConfig {
  const parsed = parseEnv(schema, env);
  if (parsed.FAULTS_ENABLED !== 'true') return { enabled: false };
  const url = urlSchema.safeParse(parsed.WORKER_ADMIN_URL ?? 'http://localhost:3001');
  if (!url.success) {
    throw new ConfigError(
      'invalid configuration: WORKER_ADMIN_URL: must be an http:// or https:// URL',
    );
  }
  return { enabled: true, workerAdminUrl: url.data.replace(/\/+$/, '') };
}
