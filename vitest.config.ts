import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Local runs read TEST_DATABASE_URL from .env. CI sets it directly.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  resolve: {
    // Test against workspace source, so tests never depend on a stale build. Exact matches only:
    // `@commerce/db/config` must not be rewritten as a prefix of `@commerce/db`.
    alias: [
      {
        find: /^@commerce\/db\/config$/,
        replacement: fileURLToPath(new URL('./packages/db/src/config.ts', import.meta.url)),
      },
      {
        find: /^@commerce\/db$/,
        replacement: fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
      },
      {
        find: /^@commerce\/telemetry$/,
        replacement: fileURLToPath(new URL('./packages/telemetry/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    // Integration tests share one database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      // Criterion 13: lifecycle, pass selection, backoff, pricing, capacity, processor,
      // reconciliation, shutdown and simulator modules, each at 80% line coverage or more.
      include: [
        'apps/worker/src/lifecycle.ts',
        'apps/worker/src/loop.ts',
        'apps/worker/src/processor.ts',
        'apps/worker/src/pass-context.ts',
        'apps/worker/src/shutdown.ts',
        'apps/worker/src/payment/simulator.ts',
        'apps/orders-api/src/pricing.ts',
        // M3a. register.ts is the preload body, exercised by `pnpm test:smoke` instead.
        'packages/telemetry/src/**/*.ts',
      ],
      exclude: ['packages/telemetry/src/register.ts', 'packages/telemetry/src/index.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 80, perFile: true },
    },
  },
});
