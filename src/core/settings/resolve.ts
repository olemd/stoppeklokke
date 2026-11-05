// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The single place for setting inheritance (§4.3): the most specific non-NULL
 * value wins, project → client → workspace → global settings → default.
 *
 * Only keys that have override columns are looked up on project/client/workspace;
 * everything else comes straight from global settings.
 */
import type { RoundingMode } from '../time/duration';
import type { Settings } from './defs';

/** A stored 0/1 (rows) or a decoded boolean (API objects); NULL = inherit. */
type Bit = number | boolean | null;

/** Rows from the database or objects from the API: both shapes resolve the same. */
export interface SettingScope {
  project?: {
    billable_default: Bit;
    alert_after_min: number | null;
    tick_interval_min: number | null;
  } | null;
  client?: { billable_default: Bit } | null;
  workspace?: {
    currency: string | null;
    default_hourly_rate: number | null;
    billable_default: Bit;
    rounding_min: number | null;
    rounding_mode: string | null;
    daily_target_min: number | null;
    alert_after_min: number | null;
    tick_interval_min: number | null;
    on_rate_change: string | null;
  } | null;
  settings: Pick<Settings, ResolvableKey>;
}

/** Keys overridable per project (columns on `projects`). */
export const PROJECT_KEYS = ['billable_default', 'alert_after_min', 'tick_interval_min'] as const;
/** Keys overridable per client (columns on `clients`). */
export const CLIENT_KEYS = ['billable_default'] as const;
/** Keys overridable per workspace (the **W** settings, plus daily_target_min). */
export const WORKSPACE_KEYS = [
  'currency',
  'default_hourly_rate',
  'billable_default',
  'rounding_min',
  'rounding_mode',
  'daily_target_min',
  'alert_after_min',
  'tick_interval_min',
  'on_rate_change',
] as const;

type Resolved = {
  billable_default: boolean;
  alert_after_min: number;
  tick_interval_min: number;
  currency: string;
  default_hourly_rate: number | null;
  rounding_min: number;
  rounding_mode: RoundingMode;
  daily_target_min: number;
  on_rate_change: 'ask' | 'lock' | 'update';
};

type ResolvableKey = keyof Resolved;

export function resolveSetting<K extends ResolvableKey>(key: K, scope: SettingScope): Resolved[K] {
  const { project, client, workspace, settings } = scope;
  const fromRow = (row: Record<string, unknown> | null | undefined): unknown => {
    const v = row?.[key];
    if (v === null || v === undefined) return undefined;
    return key === 'billable_default' ? v === 1 || v === true : v;
  };
  if ((PROJECT_KEYS as readonly string[]).includes(key)) {
    const v = fromRow(project as Record<string, unknown> | null | undefined);
    if (v !== undefined) return v as Resolved[K];
  }
  if ((CLIENT_KEYS as readonly string[]).includes(key)) {
    const v = fromRow(client as Record<string, unknown> | null | undefined);
    if (v !== undefined) return v as Resolved[K];
  }
  const w = fromRow(workspace as Record<string, unknown> | null | undefined);
  if (w !== undefined) return w as Resolved[K];
  return settings[key] as Resolved[K];
}
