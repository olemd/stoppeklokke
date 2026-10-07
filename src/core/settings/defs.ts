// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Global settings (§4.3): key/value in the `settings` table (JSON values),
 * with defaults here in code. Adding a setting never needs a migration.
 */
import { z } from 'zod';
import { ROUNDING_STEPS } from '../time/duration';
import { isValidCurrency, isValidTimeZone } from '../time/tz';

const minutes = z.number().int().min(0).max(100_000);
const QUIET = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Zod schemas for every global setting. `locale` is validated against the
 * available translations by the settings module (it knows the catalogs).
 */
export const settingSchemas = {
  active_workspace_id: z.number().int().positive().nullable(),
  timezone: z.string().refine(isValidTimeZone, 'unknown time zone'),
  locale: z.string().min(2).max(20),
  currency: z.string().refine(isValidCurrency, 'unknown ISO 4217 currency'),
  clock_format: z.enum(['24h', '12h']),
  default_hourly_rate: z.number().int().min(0).nullable(),
  on_rate_change: z.enum(['ask', 'lock', 'update']),
  alert_after_min: minutes,
  tick_interval_min: minutes,
  quiet_hours: z.string().refine((v) => v === '' || QUIET.test(v), 'expected HH:MM-HH:MM or empty'),
  rounding_min: z
    .number()
    .int()
    .refine((v) => (ROUNDING_STEPS as readonly number[]).includes(v), 'one of 0, 5, 6, 10, 15, 30'),
  rounding_mode: z.enum(['nearest', 'up', 'down']),
  daily_target_min: minutes,
  billable_default: z.boolean(),
  idle_stop_after_min: minutes,
  /** Set when the setup wizard has been completed (§5.1). */
  setup_complete: z.boolean(),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type Settings = { [K in SettingKey]: z.infer<(typeof settingSchemas)[K]> };

export const DEFAULT_SETTINGS: Settings = {
  active_workspace_id: null,
  timezone: 'UTC',
  locale: 'en',
  currency: 'EUR',
  clock_format: '24h',
  default_hourly_rate: null,
  on_rate_change: 'ask',
  alert_after_min: 240,
  tick_interval_min: 60,
  quiet_hours: '23:00-07:00',
  rounding_min: 0,
  rounding_mode: 'nearest',
  daily_target_min: 450,
  billable_default: true,
  idle_stop_after_min: 0,
  setup_complete: false,
};

export const SETTING_KEYS = Object.keys(settingSchemas) as SettingKey[];

/** Merge stored rows (JSON values) over the defaults; invalid stored values fall back. */
export function settingsFromRows(rows: { key: string; value: string }[]): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const { key, value } of rows) {
    if (!(key in settingSchemas)) continue;
    try {
      const parsed = settingSchemas[key as SettingKey].safeParse(JSON.parse(value));
      if (parsed.success) out[key] = parsed.data;
    } catch {
      // Ignore corrupt values; the default applies.
    }
  }
  return out as Settings;
}

/** Suggested currency for a locale at setup (§4.3): nb → NOK, otherwise EUR. */
export function suggestCurrency(locale: string): string {
  return locale.toLowerCase().startsWith('nb') ? 'NOK' : 'EUR';
}
