// Criterion 16, diagnostic wiring: under the production preload, an export failure must arrive
// through the rate-limited diag logger as a JSON line with otel_diag: true, and nothing from
// OpenTelemetry may reach stderr. Synchronizes on the event, not on a fixed sleep.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** A port with nothing listening: connections are refused immediately. */
async function refusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('export failures reach the rate-limited diag logger and nothing reaches stderr', async () => {
  const port = await refusedPort();
  const child = spawn(
    process.execPath,
    [
      '--import',
      './apps/worker/dist/telemetry.js',
      'packages/telemetry/smoke/fixtures/emit-spans.js',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
        OTEL_BSP_SCHEDULE_DELAY: '100',
        OTEL_EXPORTER_OTLP_TIMEOUT: '500',
        WORKER_ID: 'smoke-worker',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });

  const lines = [];
  const diagLine = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no diag line within 20 s; stdout: ${lines.join('\n')}`)),
      20_000,
    );
    let buffer = '';
    child.stdout.on('data', (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        lines.push(line);
        try {
          const json = JSON.parse(line);
          if (json.otel_diag === true && json.level === 50) {
            clearTimeout(timer);
            resolve(json);
          }
        } catch {
          // not JSON: kept in `lines` for the failure message
        }
      }
    });
    child.on('exit', (code) =>
      reject(new Error(`child exited early with ${code}; stderr: ${stderr}`)),
    );
  });
  child.kill('SIGKILL');

  assert.equal(diagLine.service, 'worker');
  assert.equal(typeof diagLine.kind, 'string');
  assert.equal(diagLine.suppressed, 0);
  assert.match(diagLine.msg, /ECONNREFUSED|export/i);
  assert.equal(stderr, '', `stderr must stay empty, got: ${stderr}`);
});
