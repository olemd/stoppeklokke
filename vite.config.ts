// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Builds the Preact PWA to dist/web, served by Workers Static Assets.
 * Version, git SHA and SOURCE_URL are baked in at build time (§7.1 footer).
 */
import preact from '@preact/preset-vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };
const gitSha = (() => {
  try {
    return execSync('git describe --always --dirty --abbrev=40').toString().trim();
  } catch {
    return 'unknown';
  }
})();

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [preact()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || pkg.version),
    __GIT_SHA__: JSON.stringify(process.env.GIT_SHA || gitSha),
    __SOURCE_URL__: JSON.stringify(
      process.env.SOURCE_URL || 'https://github.com/olemd/stoppeklokke',
    ),
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    // No inline scripts/modules: the CSP is default-src 'self' (§5.5).
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
