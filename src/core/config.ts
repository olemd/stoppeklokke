// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime configuration (§12), validated with zod.
 *
 * Invalid or missing values never crash the Worker: they are collected into
 * `errors` and surfaced in GET /api/health `config_errors`, so a fork with a
 * typo gets a readable message instead of a cryptic 500.
 */
import { z } from 'zod';

export const DEFAULT_SOURCE_URL = 'https://github.com/olemd/stoppeklokke';

const ConfigSchema = z.object({
  ORIGIN: z
    .url()
    .refine(
      (u) => new URL(u).origin === u,
      'must be a bare origin like https://example.com (no path or trailing slash)',
    ),
  RP_ID: z.string().min(1),
  RP_NAME: z.string().min(1).default('Stoppeklokke'),
  SOURCE_URL: z.url().default(DEFAULT_SOURCE_URL),
  SETUP_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:)/, 'must start with mailto: or https:')
    .optional(),
  APP_VERSION: z.string().default('0.0.0-dev'),
  GIT_SHA: z.string().default('unknown'),
});

export type AppConfig = z.output<typeof ConfigSchema>;

export interface ParsedConfig {
  config: AppConfig;
  errors: string[];
}

/** Placeholder used when a required value is invalid, so the app can still answer /api/health. */
const FALLBACK = { ORIGIN: 'http://invalid.invalid', RP_ID: 'invalid.invalid' };

export function parseConfig(raw: Record<string, unknown>): ParsedConfig {
  // Treat empty strings as unset: CI renders unset GitHub Variables as "".
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => typeof v === 'string' && v !== ''),
  );
  const res = ConfigSchema.safeParse(cleaned);
  if (res.success) {
    const errors: string[] = [];
    const c = res.data;
    const vapid = [c.VAPID_PUBLIC_KEY, c.VAPID_PRIVATE_KEY, c.VAPID_SUBJECT].filter(Boolean).length;
    if (vapid !== 0 && vapid !== 3) {
      errors.push('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set together');
    }
    const host = new URL(c.ORIGIN).hostname;
    if (host !== c.RP_ID && !host.endsWith(`.${c.RP_ID}`)) {
      errors.push(
        `RP_ID (${c.RP_ID}) must equal or be a parent domain of the ORIGIN host (${host})`,
      );
    }
    return { config: c, errors };
  }
  const errors = res.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`);
  // Re-parse with only the valid keys plus fallbacks, so defaults still apply.
  const bad = new Set(res.error.issues.map((i) => String(i.path[0])));
  const partial = Object.fromEntries(Object.entries(cleaned).filter(([k]) => !bad.has(k)));
  const config = ConfigSchema.parse({ ...FALLBACK, ...partial });
  return { config, errors };
}
