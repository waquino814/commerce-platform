// Preload entrypoint: `node --import ./apps/orders-api/dist/telemetry.js apps/orders-api/dist/main.js`.
// Must run before main.ts imports pg and fastify, so their instrumentation hooks apply.
import { hostname } from 'node:os';
import { packageVersion, registerTelemetry } from '@commerce/telemetry';

registerTelemetry({
  serviceName: 'orders-api',
  serviceInstanceId: hostname(),
  // dist/telemetry.js and src/telemetry.ts both sit one level below the app's package.json.
  serviceVersion: packageVersion(new URL('../package.json', import.meta.url)),
});
