import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');

/** The text of one top-level service block in compose.yaml. */
function composeService(name: string): string {
  const compose = read('compose.yaml');
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('telemetry infrastructure config (criterion 6, config-file test)', () => {
  it('sends traces to Jaeger with the otlp_grpc exporter, never the deprecated otlp alias', () => {
    const collector = read('infra/otel/collector.yaml');
    expect(collector).toMatch(/^ {2}otlp_grpc\/jaeger:$/m);
    expect(collector).toMatch(/exporters: \[otlp_grpc\/jaeger\]/);
    const exportersBlock = collector.slice(
      collector.indexOf('\nexporters:'),
      collector.indexOf('\nservice:'),
    );
    expect(exportersBlock).not.toMatch(/^ {2}otlp(\/[a-z]+)?:$/m);
    expect(collector).toMatch(/health_check:\n\s+# .*\n\s+endpoint: 0\.0\.0\.0:13133/);
  });

  it('keeps job and instance from the collector with honor_labels on its scrape job', () => {
    const prometheus = read('infra/prometheus/prometheus.yml');
    expect(prometheus).toMatch(/- job_name: otel-collector\n(\s+#.*\n)*\s+honor_labels: true/);
    expect(prometheus).toMatch(/targets: \['otel-collector:8889'\]/);
  });

  it('pins exact images, binds Jaeger explicitly, and keeps apps independent of telemetry', () => {
    expect(composeService('otel-collector')).toContain(
      'image: otel/opentelemetry-collector-contrib:0.162.0',
    );
    const jaeger = composeService('jaeger');
    expect(jaeger).toContain('image: jaegertracing/jaeger:2.22.0');
    expect(jaeger).toMatch(/JAEGER_LISTEN_HOST: 0\.0\.0\.0/);
    expect(jaeger).toContain('http://127.0.0.1:13133/status');
    expect(composeService('prometheus')).toContain('image: prom/prometheus:v3.15.0');
    for (const app of ['orders-api', 'worker']) {
      const block = composeService(app);
      expect(block).toContain(`'--import', './apps/${app}/dist/telemetry.js'`);
      expect(block).toContain('OTEL_EXPORTER_OTLP_ENDPOINT: *otlp-endpoint');
      expect(block).not.toMatch(
        /otel-collector:\n\s+condition|jaeger:\n\s+condition|prometheus:\n\s+condition/,
      );
    }
  });

  it('resolves exactly one @opentelemetry/api version, so every package shares one diag logger', () => {
    const lock = read('pnpm-lock.yaml');
    const versions = new Set(
      [...lock.matchAll(/^ {2}'@opentelemetry\/api@([0-9][^':(]*)':/gm)].map((m) => m[1]),
    );
    expect([...versions]).toEqual(['1.9.1']);
  });
});
