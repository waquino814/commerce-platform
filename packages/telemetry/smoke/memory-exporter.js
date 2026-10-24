// Smoke-test preload, loaded with `--import` before the production preload. It installs an
// in-memory exporter through the test seam read by registerTelemetry(); production never sets it.
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

globalThis[Symbol.for('commerce.telemetry.testSpanExporter')] = new InMemorySpanExporter();
