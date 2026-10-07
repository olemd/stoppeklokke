// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared read helpers for the core tables. Small tables are loaded whole. */
import { badRequest, notFound } from '../../core/errors';
import type { ClientRow, ProjectRow, WorkspaceRow } from '../../core/model';
import type { RateLookup } from '../../core/rates/resolve';
import { settingsFromRows, type Settings } from '../../core/settings/defs';
import type { Ctx } from '../types';

export async function loadSettings(ctx: Ctx): Promise<Settings> {
  return settingsFromRows(
    await ctx.db.all<{ key: string; value: string }>('SELECT key, value FROM settings'),
  );
}

export async function getWorkspace(ctx: Ctx, id: number): Promise<WorkspaceRow | null> {
  return ctx.db.first<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', id);
}
export async function getClient(ctx: Ctx, id: number): Promise<ClientRow | null> {
  return ctx.db.first<ClientRow>('SELECT * FROM clients WHERE id = ?', id);
}
export async function getProject(ctx: Ctx, id: number): Promise<ProjectRow | null> {
  return ctx.db.first<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
}

export async function requireWorkspace(ctx: Ctx, id: number): Promise<WorkspaceRow> {
  const w = await getWorkspace(ctx, id);
  if (!w) throw notFound('workspace_not_found');
  return w;
}
export async function requireClient(ctx: Ctx, id: number): Promise<ClientRow> {
  const c = await getClient(ctx, id);
  if (!c) throw notFound('client_not_found');
  return c;
}
export async function requireProject(ctx: Ctx, id: number): Promise<ProjectRow> {
  const p = await getProject(ctx, id);
  if (!p) throw notFound('project_not_found');
  return p;
}

/**
 * The active workspace (§4.4): the stored one if it exists and is not
 * archived, otherwise the first non-archived workspace by sort order.
 */
export async function activeWorkspaceId(ctx: Ctx, settings: Settings): Promise<number> {
  if (settings.active_workspace_id !== null) {
    const w = await getWorkspace(ctx, settings.active_workspace_id);
    if (w && !w.archived) return w.id;
  }
  const first = await ctx.db.first<{ id: number }>(
    'SELECT id FROM workspaces WHERE archived = 0 ORDER BY sort_order, id LIMIT 1',
  );
  if (!first) throw badRequest('no_workspace', 'Create a workspace first');
  return first.id;
}

/** Everything resolveRate/resolveSetting need, in one round trip. */
export async function loadLookup(ctx: Ctx): Promise<RateLookup> {
  const [ws, cs, ps, ss] = await ctx.db.batch([
    { sql: 'SELECT * FROM workspaces', params: [] },
    { sql: 'SELECT * FROM clients', params: [] },
    { sql: 'SELECT * FROM projects', params: [] },
    { sql: 'SELECT key, value FROM settings', params: [] },
  ]);
  const map = <T extends { id: number }>(rows: unknown[]) =>
    new Map((rows as T[]).map((r) => [r.id, r]));
  return {
    workspaces: map<WorkspaceRow>(ws!.rows),
    clients: map<ClientRow>(cs!.rows),
    projects: map<ProjectRow>(ps!.rows),
    settings: settingsFromRows(ss!.rows as { key: string; value: string }[]),
  };
}
