// M4 smoke checks on the built output (D5), run by `pnpm test:smoke` after `pnpm build`:
//   - criterion 4: the built @commerce/db/catalog module loads neither pg nor the pool module;
//   - criterion 1: the dry run gives the same plan hash in separate processes, with no network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const loadgenDir = fileURLToPath(new URL('../', import.meta.url));
const GOLDEN = 'ba75539e9eac6c3754b0b0982d2afa0d9484cabdce827263bd38f10d850603f4';

/** Imports `specifier` from the load generator's package in a fresh process; returns resolutions. */
function resolutionsOf(specifier) {
  const out = execFileSync(
    process.execPath,
    [
      '--import',
      './smoke/fixtures/record-resolutions.js',
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(specifier)});`,
    ],
    { cwd: loadgenDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const line = out.split('\n').find((l) => l.startsWith('RESOLVED '));
  assert.ok(line, `no resolution record; stdout: ${out}`);
  return JSON.parse(line.slice('RESOLVED '.length));
}

const loadsPg = (resolutions) =>
  resolutions.some((r) => r.specifier === 'pg' || /\/pool\.js$/.test(r.url));

test('the built catalog module has no imports and never loads pg or the pool (criterion 4)', () => {
  const built = readFileSync(
    new URL('../../../packages/db/dist/catalog.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(built, /^\s*import\s/m, 'dist/catalog.js must not import anything');
  assert.doesNotMatch(built, /\brequire\(/);

  const catalog = resolutionsOf('@commerce/db/catalog');
  assert.ok(
    catalog.some((r) => r.url.endsWith('/packages/db/dist/catalog.js')),
    `the catalog subpath must resolve to the built catalog; got ${JSON.stringify(catalog)}`,
  );
  assert.equal(loadsPg(catalog), false, `catalog import loaded: ${JSON.stringify(catalog)}`);

  // Positive control: the package root does load pg, so the recorder can see it.
  assert.equal(loadsPg(resolutionsOf('@commerce/db')), true);
});

test('the dry run prints the golden hash in separate processes and sends nothing (criterion 1)', () => {
  const dryRun = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['apps/loadgen/dist/main.js', '--profile', 'steady', '--seed', '42', '--dry-run', '--json'],
        {
          cwd: root,
          encoding: 'utf8',
          // An unreachable target: a dry run must never connect.
          env: { ...process.env, ORDERS_API_URL: 'http://127.0.0.1:9' },
          timeout: 20_000,
        },
      ),
    );
  const first = dryRun();
  const second = dryRun();
  assert.equal(first.planHash, GOLDEN);
  assert.equal(second.planHash, GOLDEN);
  assert.deepEqual(first, second);
  assert.equal(first.dryRun, true);
});
