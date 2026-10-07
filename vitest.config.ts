// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tests run inside workerd with a local D1 (§2): `bun run test`, never `bun test`.
 * Bindings are declared here rather than read from wrangler.jsonc, so tests
 * work without a rendered config (the template is fork-specific).
 */
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        main: './src/platform/cloudflare/worker.ts',
        miniflare: {
          compatibilityDate: '2026-08-15',
          d1Databases: ['DB'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            ORIGIN: 'https://stoppeklokke.test',
            RP_ID: 'stoppeklokke.test',
            SETUP_TOKEN: 'test-setup-token-0123456789',
            APP_VERSION: '9.9.9',
            GIT_SHA: 'testsha',
          },
          // Mirrors wrangler.template.jsonc so asset routing is tested as deployed.
          assets: {
            directory: './test/fixtures/assets',
            binding: 'ASSETS',
            run_worker_first: ['/api/*', '/assets/*'],
            assetConfig: { not_found_handling: 'single-page-application' },
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.ts'],
    },
  };
});
