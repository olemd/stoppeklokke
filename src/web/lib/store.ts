// SPDX-License-Identifier: AGPL-3.0-or-later
/** App state as signals, loaded from the API. Single user, so this is the whole world. */
import { computed, signal } from '@preact/signals';
import type { Client, Entry, Project, Workspace } from '../../shared/schemas';
import { get } from './api';

export interface AuthStatus {
  setup_required: boolean;
  authenticated: boolean;
  must_register: boolean;
}

export interface Settings {
  active_workspace_id: number | null;
  timezone: string;
  locale: string;
  currency: string;
  clock_format: '24h' | '12h';
  default_hourly_rate: number | null;
  on_rate_change: 'ask' | 'lock' | 'update';
  alert_after_min: number;
  tick_interval_min: number;
  quiet_hours: string;
  rounding_min: number;
  rounding_mode: 'nearest' | 'up' | 'down';
  daily_target_min: number;
  billable_default: boolean;
  idle_stop_after_min: number;
  setup_complete: boolean;
}

export const auth = signal<AuthStatus | null>(null);
export const settings = signal<Settings | null>(null);
export const workspaces = signal<Workspace[]>([]);
export const clients = signal<Client[]>([]);
export const projects = signal<Project[]>([]);
export const timer = signal<Entry | null>(null);
export const online = signal(navigator.onLine);
/** Workspace filter for log/reports: an id, or 'all'. Defaults to the active one. */
export const viewWorkspace = signal<number | 'all' | null>(null);

addEventListener('online', () => (online.value = true));
addEventListener('offline', () => (online.value = false));

export const activeWorkspaces = computed(() => workspaces.value.filter((w) => !w.archived));
/** With one workspace, the switcher and all workspace columns are hidden (§4.4). */
export const multiWorkspace = computed(() => activeWorkspaces.value.length > 1);

export const activeWorkspaceId = computed<number | null>(() => {
  const s = settings.value;
  const active = activeWorkspaces.value;
  return active.find((w) => w.id === s?.active_workspace_id)?.id ?? active[0]?.id ?? null;
});

/** The workspace id used to filter the log and reports, or null for all. */
export const filterWorkspaceId = computed<number | null>(() => {
  const v = viewWorkspace.value;
  if (!multiWorkspace.value || v === 'all') return null;
  return v ?? activeWorkspaceId.value;
});

export const workspaceById = computed(() => new Map(workspaces.value.map((w) => [w.id, w])));
export const clientById = computed(() => new Map(clients.value.map((c) => [c.id, c])));
export const projectById = computed(() => new Map(projects.value.map((p) => [p.id, p])));

export async function loadAuth() {
  auth.value = await get<AuthStatus>('/auth/status');
}

export async function loadSettings() {
  settings.value = await get<Settings>('/settings');
}

export async function loadCatalog() {
  const [w, c, p] = await Promise.all([
    get<Workspace[]>('/workspaces'),
    get<Client[]>('/clients'),
    get<Project[]>('/projects'),
  ]);
  workspaces.value = w;
  clients.value = c;
  projects.value = p;
}

export async function loadTimer() {
  timer.value = await get<Entry | null>('/timer');
}

export async function loadAll() {
  await Promise.all([loadSettings(), loadCatalog(), loadTimer()]);
}
