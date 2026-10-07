// SPDX-License-Identifier: AGPL-3.0-or-later
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Cloudflare-specific imports are only allowed in src/platform/cloudflare/ (§15.4),
// so a future platform/bun/ is a bounded piece of work.
const cloudflareImports = {
  patterns: [
    {
      group: ['cloudflare:*', '@cloudflare/*'],
      message: 'Cloudflare APIs are only allowed in src/platform/cloudflare/.',
    },
  ],
};

// The Worker runs on workerd: Bun APIs belong in scripts/ only (§2.1).
const bunImports = {
  group: ['bun', 'bun:*'],
  message: 'Bun APIs are only allowed in scripts/.',
};

export default tseslint.config(
  {
    ignores: [
      'dist/',
      '.wrangler/',
      'node_modules/',
      '.remember/',
      'src/shared/i18n/catalogs.generated.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Tests may use `any` for response bodies.
    files: ['test/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/platform/cloudflare/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...cloudflareImports.patterns, bunImports] }],
      'no-restricted-globals': [
        'error',
        { name: 'Bun', message: 'Bun APIs are only allowed in scripts/.' },
      ],
    },
  },
  {
    files: ['src/platform/cloudflare/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [bunImports] }],
      'no-restricted-globals': [
        'error',
        { name: 'Bun', message: 'Bun APIs are only allowed in scripts/.' },
      ],
    },
  },
);
