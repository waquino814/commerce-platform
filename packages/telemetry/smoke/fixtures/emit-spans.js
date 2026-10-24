// Child process for diag-wiring.test.js: keeps producing spans so the exporter keeps failing.
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('smoke');
setInterval(() => {
  tracer.startSpan('smoke.tick').end();
}, 50);
