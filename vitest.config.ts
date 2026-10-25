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
        find: /^@commerce\/db\/catalog$/,
        replacement: fileURLToPath(new URL('./packages/db/src/catalog.ts', import.meta.url)),
      },
      {
        find: /^@commerce\/db\/config$/,
        replacement: fileURLToPath(new URL('./packages/db/src/config.ts', import.meta.url)),
      },
      {
        find: /^@commerce\/db$/,
        replacement: fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
      },
      {
        find: /^@commerce\/incident-bundle$/,
        replacement: fileURLToPath(
          new URL('./packages/incident-bundle/src/index.ts', import.meta.url),
        ),
      },
      {
        find: /^@commerce\/faults$/,
        replacement: fileURLToPath(new URL('./packages/faults/src/index.ts', import.meta.url)),
      },
      {
        find: /^@commerce\/loadgen$/,
        replacement: fileURLToPath(new URL('./apps/loadgen/src/index.ts', import.meta.url)),
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
        'apps/worker/src/recovery.ts',
        // M3c.
        'apps/worker/src/order-status-sampler.ts',
        'apps/worker/src/worker-metrics.ts',
        // M4. main.ts is the thin CLI entry; cli.ts holds its logic and is tested.
        'apps/loadgen/src/**/*.ts',
        'apps/worker/src/payment/simulator.ts',
        'apps/orders-api/src/pricing.ts',
        // M3a. register.ts is the preload body, exercised by `pnpm test:smoke` instead.
        'packages/telemetry/src/**/*.ts',
        // M5a: the fault and bundle packages, and the apps' fault wiring.
        'packages/faults/src/**/*.ts',
        'packages/incident-bundle/src/**/*.ts',
        'apps/orders-api/src/admin.ts',
        'apps/orders-api/src/faults.ts',
        'apps/orders-api/src/faults-config.ts',
        'apps/orders-api/src/shutdown.ts',
        'apps/worker/src/admin.ts',
        'apps/worker/src/faults.ts',
        'apps/worker/src/faults-config.ts',
        // M5b: the capture clients.
        'apps/incident/src/**/*.ts',
      ],
      exclude: [
        'packages/telemetry/src/register.ts',
        'packages/telemetry/src/index.ts',
        'apps/loadgen/src/main.ts',
        'packages/faults/src/index.ts',
        'packages/incident-bundle/src/index.ts',
        'apps/incident/src/index.ts',
        // M5c. main.ts is the thin CLI entry; cli.ts and run.ts hold its logic and are tested.
        'apps/incident/src/main.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 80, perFile: true },
    },
  },
});
