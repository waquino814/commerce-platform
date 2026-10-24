import { register } from 'node:module';
import { ConfigError } from '@commerce/db/config';
import type { SpanExporter } from '@opentelemetry/sdk-trace-node';
import { pino } from 'pino';
import { loadTelemetryConfig } from './config.js';
import { DISABLED_TELEMETRY, setActiveTelemetry, type TelemetryHandle } from './handle.js';
import { startTelemetry } from './sdk.js';

const TEST_SPAN_EXPORTER = Symbol.for('commerce.telemetry.testSpanExporter');

/**
 * Body of each app's preload entrypoint, loaded with `node --import` before the app's main module.
 * With telemetry enabled it registers the ESM import hook first, so `pg` and `http` are patched
 * when the app imports them, then starts the SDK and hands the handle to main via
 * getActiveTelemetry(). Invalid config exits 1 with a message naming the variable.
 */
export function registerTelemetry(defaults: {
  serviceName: string;
  serviceInstanceId: string;
}): TelemetryHandle {
  let config;
  try {
    config = loadTelemetryConfig(process.env, defaults);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`${defaults.serviceName}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  if (!config.enabled) {
    setActiveTelemetry(DISABLED_TELEMETRY);
    return DISABLED_TELEMETRY;
  }

  // module.register is what OpenTelemetry 0.223 documents for its ESM hook and what the M3a spike
  // tested; it emits no runtime deprecation warning on Node 24. Moving to module.registerHooks()
  // is a tracked follow-up (docs/prompts/m3-design.md, "Known risks").
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const diagOut = pino({ base: { service: config.serviceName } });
  const testExporter = (globalThis as { [TEST_SPAN_EXPORTER]?: SpanExporter })[TEST_SPAN_EXPORTER];
  const handle = startTelemetry({
    config,
    emitDiag: (line) => {
      diagOut[line.level](
        { otel_diag: true, kind: line.kind, suppressed: line.suppressed },
        line.msg,
      );
    },
    ...(testExporter ? { spanExporter: testExporter } : {}),
  });
  setActiveTelemetry(handle);
  return handle;
}
