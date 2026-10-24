// Worker preload smoke test: under the worker's real production preload, pg must not be loaded
// before the worker's application modules, and must be patched once they have loaded it. A
// control run with telemetry disabled proves the check can tell patched from unpatched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function probe(endpoint) {
  const env = { ...process.env, WORKER_ID: 'smoke-worker' };
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint) env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  const out = execFileSync(
    process.execPath,
    [
      '--import',
      './apps/worker/dist/telemetry.js',
      'packages/telemetry/smoke/fixtures/worker-pg-probe.js',
    ],
    { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const line = out
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.includes('"telemetryEnabled"'));
  assert.ok(line, `probe printed no result; stdout: ${out}`);
  return JSON.parse(line);
}

test('worker preload: pg is unloaded before the app modules and patched after them', () => {
  const result = probe('http://127.0.0.1:9');
  assert.equal(result.telemetryEnabled, true);
  assert.equal(result.before.pgLoaded, false, 'the preload itself must not load pg');
  assert.equal(result.after.pgLoaded, true, 'the worker modules must load pg');
  assert.equal(result.after.sameInstanceFound, true);
  assert.equal(result.after.pgQueryPatched, true, 'pg loaded by the worker must be instrumented');
});

test('control: with telemetry disabled, the same probe sees pg loaded but not patched', () => {
  const result = probe(undefined);
  assert.equal(result.telemetryEnabled, false);
  assert.equal(result.before.pgLoaded, false);
  assert.equal(result.after.pgLoaded, true);
  assert.equal(result.after.sameInstanceFound, true);
  assert.equal(result.after.pgQueryPatched, false);
});
