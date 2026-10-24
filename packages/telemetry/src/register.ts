import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { ConfigError } from '@commerce/db/config';
import type { MetricReader } from '@opentelemetry/sdk-metrics';
import type { SpanExporter } from '@opentelemetry/sdk-trace-node';
import { pino } from 'pino';
import { loadTelemetryConfig } from './config.js';
import { DISABLED_TELEMETRY, setActiveTelemetry, type TelemetryHandle } from './handle.js';
import { startTelemetry } from './sdk.js';

const TEST_SPAN_EXPORTER = Symbol.for('commerce.telemetry.testSpanExporter');
const TEST_METRIC_READER = Symbol.for('commerce.telemetry.testMetricReader');

/**
 * Body of each app's preload entrypoint, loaded with `node --import` before the app's main module.
 * With telemetry enabled it registers the ESM import hook first, so `pg` and `http` are patched
 * when the app imports them, then starts the SDK and hands the handle to main via
 * getActiveTelemetry(). Invalid config exits 1 with a message naming the variable.
 */
export function registerTelemetry(defaults: {
  serviceName: string;
  serviceInstanceId: string;
  serviceVersion: string;
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
  const seams = globalThis as {
    [TEST_SPAN_EXPORTER]?: SpanExporter;
    [TEST_METRIC_READER]?: MetricReader;
  };
  const testExporter = seams[TEST_SPAN_EXPORTER];
  const testReader = seams[TEST_METRIC_READER];
  const handle = startTelemetry({
    config,
    emitDiag: (line) => {
      diagOut[line.level](
        { otel_diag: true, kind: line.kind, suppressed: line.suppressed },
        line.msg,
      );
    },
    ...(testExporter ? { spanExporter: testExporter } : {}),
    ...(testReader ? { metricReader: testReader } : {}),
  });
  setActiveTelemetry(handle);
  return handle;
}

/**
 * Reads `version` from an app's package.json for the resource's `service.version`. Returns
 * "unknown" when the file is missing or has no string version, so telemetry never blocks startup.
 */
export function packageVersion(packageJsonUrl: URL): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
