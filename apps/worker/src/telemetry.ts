// Preload entrypoint: `node --import ./apps/worker/dist/telemetry.js apps/worker/dist/main.js`.
// Must run before main.ts imports pg, so its instrumentation hooks apply.
import { hostname } from 'node:os';
import { registerTelemetry } from '@commerce/telemetry';

registerTelemetry({
  serviceName: 'worker',
  serviceInstanceId: process.env.WORKER_ID?.trim() || hostname(),
});
