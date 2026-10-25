import { parseEnv } from '@commerce/db';
import { z } from 'zod';

/**
 * M5 fault configuration, separate from the main config so M2's config contract is unchanged.
 * Only `FAULTS_ENABLED=true` makes the scenario control endpoints exist; it never starts a
 * scenario.
 */
const schema = z.object({ FAULTS_ENABLED: z.enum(['true', 'false']).default('false') });

export function loadFaultsConfig(env: NodeJS.ProcessEnv): { readonly enabled: boolean } {
  return { enabled: parseEnv(schema, env).FAULTS_ENABLED === 'true' };
}
