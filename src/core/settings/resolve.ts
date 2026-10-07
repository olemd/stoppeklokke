// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The single place for setting inheritance (§4.3): the most specific non-NULL
 * value wins, project → workspace → global settings → default.
 *
 * Only keys that have override columns are looked up on project/workspace;
 * everything else comes straight from global settings.
 */
import type { ProjectRow, WorkspaceRow } from '../model';
import type { RoundingMode } from '../time/duration';
import type { Settings } from './defs';

export interface SettingScope {
  project?: Pick<ProjectRow, 'billable_default' | 'alert_after_min' | 'tick_interval_min'> | null;
  workspace?: Pick<
    WorkspaceRow,
    | 'currency'
    | 'default_hourly_rate'
    | 'billable_default'
    | 'rounding_min'
    | 'rounding_mode'
    | 'daily_target_min'
    | 'alert_after_min'
    | 'tick_interval_min'
    | 'on_rate_change'
  > | null;
  settings: Settings;
}

/** Keys overridable per project (columns on `projects`). */
export const PROJECT_KEYS = ['billable_default', 'alert_after_min', 'tick_interval_min'] as const;
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
  const { project, workspace, settings } = scope;
  const fromRow = (row: Record<string, unknown> | null | undefined): unknown => {
    const v = row?.[key];
    if (v === null || v === undefined) return undefined;
    return key === 'billable_default' ? v === 1 || v === true : v;
  };
  if ((PROJECT_KEYS as readonly string[]).includes(key)) {
    const v = fromRow(project as Record<string, unknown> | null | undefined);
    if (v !== undefined) return v as Resolved[K];
  }
  const w = fromRow(workspace as Record<string, unknown> | null | undefined);
  if (w !== undefined) return w as Resolved[K];
  return settings[key] as Resolved[K];
}
