// SPDX-License-Identifier: AGPL-3.0-or-later
/** Projects (§4): optional client, rate/currency and notification overrides. */
import { createRoute, z } from '@hono/zod-openapi';
import { badRequest, conflict } from '../../core/errors';
import type { ProjectRow } from '../../core/model';
import { Id, Project, ProjectCreate, ProjectPatch } from '../../shared/schemas';
import { uniqueName } from '../data/errors';
import {
  activeWorkspaceId,
  loadSettings,
  requireClient,
  requireProject,
  requireWorkspace,
} from '../data/repo';
import { bit, body, bool, json, setClause } from '../http';
import { planRateChange, runWithPlan } from '../rates/change';
import type { Module } from '../types';

export const toProject = (r: ProjectRow): Project => ({
  ...r,
  billable_default: bool(r.billable_default),
  archived: r.archived === 1,
});

const IdParam = z.object({ id: Id });
const COLUMNS = [
  'client_id',
  'name',
  'color',
  'hourly_rate',
  'currency',
  'billable_default',
  'alert_after_min',
  'tick_interval_min',
  'archived',
] as const;

export const projectsModule: Module = {
  name: 'projects',
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['projects'],
        request: { query: z.object({ workspace_id: Id.optional(), client_id: Id.optional() }) },
        responses: { 200: json(z.array(Project)) },
      }),
      async (c) => {
        const { workspace_id, client_id } = c.req.valid('query');
        const where: string[] = [];
        const params: number[] = [];
        if (workspace_id) {
          where.push('workspace_id = ?');
          params.push(workspace_id);
        }
        if (client_id) {
          where.push('client_id = ?');
          params.push(client_id);
        }
        const rows = await c.env.ctx.db.all<ProjectRow>(
          `SELECT * FROM projects ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE`,
          ...params,
        );
        return c.json(rows.map(toProject), 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/',
        tags: ['projects'],
        request: body(ProjectCreate),
        responses: { 201: json(Project) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const input = c.req.valid('json');
        let workspaceId = input.workspace_id;
        if (input.client_id) {
          const client = await requireClient(ctx, input.client_id);
          // A project with a client must be in the client's workspace (§4).
          if (workspaceId && workspaceId !== client.workspace_id) {
            throw badRequest('workspace_conflict', 'The client belongs to another workspace');
          }
          workspaceId = client.workspace_id;
        }
        workspaceId ??= await activeWorkspaceId(ctx, await loadSettings(ctx));
        await requireWorkspace(ctx, workspaceId);
        const now = ctx.clock.now();
        const row = await uniqueName(
          ctx.db.first<ProjectRow>(
            `INSERT INTO projects (workspace_id, client_id, name, color, hourly_rate, currency, billable_default,
                                   alert_after_min, tick_interval_min, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            workspaceId,
            input.client_id ?? null,
            input.name,
            input.color ?? '#4f7cff',
            input.hourly_rate ?? null,
            input.currency ?? null,
            bit(input.billable_default) ?? null,
            input.alert_after_min ?? null,
            input.tick_interval_min ?? null,
            now,
            now,
          ),
        );
        return c.json(toProject(row!), 201);
      },
    );

    app.openapi(
      createRoute({
        method: 'patch',
        path: '/{id}',
        tags: ['projects'],
        request: { params: IdParam, ...body(ProjectPatch) },
        responses: { 200: json(Project.extend({ rate_change_result: z.unknown().optional() })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { id } = c.req.valid('param');
        const input = c.req.valid('json');
        const current = await requireProject(ctx, id);
        const now = ctx.clock.now();
        const extra = [];
        const clientChanged =
          input.client_id !== undefined && input.client_id !== current.client_id;
        if (clientChanged) {
          if (input.client_id !== null) {
            const client = await requireClient(ctx, input.client_id!);
            if (client.workspace_id !== current.workspace_id) {
              throw badRequest('workspace_conflict', 'The client belongs to another workspace');
            }
          }
          const locked = await ctx.db.first(
            'SELECT 1 FROM time_entries WHERE project_id = ? AND period_lock_id IS NOT NULL LIMIT 1',
            id,
          );
          if (locked)
            throw conflict(
              'project_locked',
              'The project has period-locked time; its client cannot change',
            );
          // Entries follow the project's client (§4 derivation rule).
          extra.push({
            sql: 'UPDATE time_entries SET client_id = ?, updated_at = ? WHERE project_id = ?',
            params: [input.client_id ?? null, now, id],
          });
        }
        const plan = await planRateChange(
          ctx,
          {
            level: 'project',
            id,
            rateChanged:
              input.hourly_rate !== undefined && input.hourly_rate !== current.hourly_rate,
            currencyChanged: input.currency !== undefined && input.currency !== current.currency,
          },
          input.rate_change,
        );
        const { sql, params } = setClause(
          {
            ...input,
            billable_default: bit(input.billable_default),
            archived: bit(input.archived),
            rate_change: undefined,
          },
          COLUMNS,
        );
        const update = sql
          ? [
              {
                sql: `UPDATE projects SET ${sql}, updated_at = ? WHERE id = ?`,
                params: [...params, now, id],
              },
              ...extra,
            ]
          : extra;
        const result = await uniqueName(runWithPlan(ctx, plan, update, { level: 'project', id }));
        return c.json(
          { ...toProject(await requireProject(ctx, id)), rate_change_result: result },
          200,
        );
      },
    );

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/{id}',
        tags: ['projects'],
        request: { params: IdParam },
        responses: { 200: json(z.object({ ok: z.literal(true) })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { id } = c.req.valid('param');
        await requireProject(ctx, id);
        const r = await ctx.db.run(
          `DELETE FROM projects WHERE id = ?
             AND NOT EXISTS (SELECT 1 FROM time_entries WHERE project_id = ?)
             AND NOT EXISTS (SELECT 1 FROM period_locks WHERE project_id = ?)`,
          id,
          id,
          id,
        );
        if (r.changes !== 1) throw conflict('not_empty', 'Project has time; archive it instead');
        return c.json({ ok: true as const }, 200);
      },
    );
  },
};
