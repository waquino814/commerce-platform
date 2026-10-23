import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Local runs read TEST_DATABASE_URL from .env. CI sets it directly.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  resolve: {
    alias: {
      // Test against workspace source, so tests never depend on a stale build.
      '@commerce/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    // Integration tests share one database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
