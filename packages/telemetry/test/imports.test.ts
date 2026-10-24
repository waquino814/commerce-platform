import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The preload must register the ESM hook before anything imports `pg`. Static imports run before
 * the preload's body, so nothing a preload entry or the telemetry package imports may load `pg`.
 * `@commerce/db`'s root entry loads `pg`; only its `./config` subpath (zod only) is allowed.
 *
 * Matches every way a module can be loaded: named and default imports, side-effect imports
 * (`import '@commerce/db'`), re-exports (`export ... from`), and dynamic `import()`.
 */
const UNSAFE_MODULE_LOAD = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](?:@commerce\/db|pg)['"]/;

const preloadSources: (readonly [string, string])[] = [
  ...readdirSync('packages/telemetry/src')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `packages/telemetry/src/${f}`),
  'apps/orders-api/src/telemetry.ts',
  'apps/worker/src/telemetry.ts',
].map((path) => [path, readFileSync(path, 'utf8')] as const);

describe('preload import graph', () => {
  it('scans the telemetry package and both apps’ preload entries', () => {
    const paths = preloadSources.map(([p]) => p);
    expect(paths).toContain('apps/orders-api/src/telemetry.ts');
    expect(paths).toContain('apps/worker/src/telemetry.ts');
    expect(paths).toContain('packages/telemetry/src/register.ts');
  });

  it.each(preloadSources)('%s never loads pg or the @commerce/db root entry', (_path, text) => {
    expect(text).not.toMatch(UNSAFE_MODULE_LOAD);
  });

  it.each([
    "import { createPool } from '@commerce/db';",
    "import * as db from '@commerce/db';",
    "import '@commerce/db';",
    'import "@commerce/db";',
    "export { createPool } from '@commerce/db';",
    "export * from '@commerce/db';",
    "await import('@commerce/db');",
    "import pg from 'pg';",
    "import 'pg';",
    "const pg = await import('pg');",
  ])('the matcher catches %s', (statement) => {
    expect(statement).toMatch(UNSAFE_MODULE_LOAD);
  });

  it.each([
    "import { ConfigError } from '@commerce/db/config';",
    "import type { Pool } from '@commerce/database';",
    "import { register } from 'node:module';",
    "import { pino } from 'pino';",
  ])('the matcher allows %s', (statement) => {
    expect(statement).not.toMatch(UNSAFE_MODULE_LOAD);
  });

  it('the allowed @commerce/db/config subpath imports only zod', () => {
    const config = readFileSync('packages/db/src/config.ts', 'utf8');
    const imports = [...config.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['zod']);
  });
});
