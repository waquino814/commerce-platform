// Child process for worker-preload.test.js, started under the worker's production preload:
//   node --import ./apps/worker/dist/telemetry.js packages/telemetry/smoke/fixtures/worker-pg-probe.js
// Records whether pg is loaded before the worker's application modules are imported, then imports
// them and records whether the pg instance they loaded is patched. It never imports pg itself
// before the application modules do.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pgLoaded = () =>
  Object.keys(require.cache).some((k) => /[\\/]pg[\\/]lib[\\/]index\.js$/.test(k));

const before = { pgLoaded: pgLoaded() };

// The worker's application modules that load pg through @commerce/db, without starting main().
await import('../../../../apps/worker/dist/processor.js');
await import('../../../../apps/worker/dist/payment/simulator.js');

const afterLoaded = pgLoaded();
// Resolve pg exactly as @commerce/db does; this returns the instance the app modules already loaded.
const pgPath = createRequire(new URL('../../../db/package.json', import.meta.url)).resolve('pg');
const pg = require.cache[pgPath]?.exports;
const { getActiveTelemetry } = await import('@commerce/telemetry');

console.log(
  JSON.stringify({
    telemetryEnabled: getActiveTelemetry().enabled,
    before,
    after: {
      pgLoaded: afterLoaded,
      sameInstanceFound: pg !== undefined,
      pgQueryPatched: Boolean(pg?.Client?.prototype?.query?.__wrapped),
    },
  }),
);
process.exit(0);
