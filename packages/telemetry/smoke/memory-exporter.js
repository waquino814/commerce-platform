// Smoke-test preload, loaded with `--import` before the production preload. It installs an
// in-memory span exporter and a collect-on-demand metric reader through the test seams read by
// registerTelemetry(); production never sets them.
import { MetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

class CollectingReader extends MetricReader {
  onForceFlush() {
    return Promise.resolve();
  }
  onShutdown() {
    return Promise.resolve();
  }
}

globalThis[Symbol.for('commerce.telemetry.testSpanExporter')] = new InMemorySpanExporter();
globalThis[Symbol.for('commerce.telemetry.testMetricReader')] = new CollectingReader();
