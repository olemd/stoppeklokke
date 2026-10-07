// SPDX-License-Identifier: AGPL-3.0-or-later
/** Row types mirroring the D1 schema (§4). Booleans are stored as 0/1. */

export interface WorkspaceRow {
  id: number;
  name: string;
  color: string;
  currency: string | null;
  default_hourly_rate: number | null;
  billable_default: number | null;
  rounding_min: number | null;
  rounding_mode: string | null;
  daily_target_min: number | null;
  alert_after_min: number | null;
  tick_interval_min: number | null;
  on_rate_change: string | null;
  sort_order: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface ClientRow {
  id: number;
  workspace_id: number;
  name: string;
  hourly_rate: number | null;
  currency: string | null;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface ProjectRow {
  id: number;
  workspace_id: number;
  client_id: number | null;
  name: string;
  color: string;
  hourly_rate: number | null;
  currency: string | null;
  billable_default: number | null;
  alert_after_min: number | null;
  tick_interval_min: number | null;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface EntryRow {
  id: number;
  workspace_id: number;
  client_id: number | null;
  project_id: number | null;
  description: string;
  start_at: number;
  end_at: number | null;
  billable: number;
  rate_locked_at: number | null;
  locked_rate: number | null;
  locked_currency: string | null;
  period_lock_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface PeriodLockRow {
  id: number;
  from_date: string;
  to_date: string;
  from_at: number;
  to_at: number;
  timezone: string;
  workspace_id: number;
  client_id: number | null;
  project_id: number | null;
  rounding_min: number;
  rounding_mode: string;
  note: string;
  locked_at: number;
}
