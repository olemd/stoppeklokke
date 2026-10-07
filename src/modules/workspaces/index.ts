// SPDX-License-Identifier: AGPL-3.0-or-later
/** Workspaces (§4.4): one per role, each with overrides of the W settings. */
import { createRoute, z } from '@hono/zod-openapi';
import { conflict } from '../../core/errors';
import type { WorkspaceRow } from '../../core/model';
import { Id, Workspace, WorkspaceCreate, WorkspacePatch } from '../../shared/schemas';
import { uniqueName } from '../data/errors';
import { requireWorkspace } from '../data/repo';
import { bit, body, bool, json, setClause } from '../http';
import { planRateChange, runWithPlan } from '../rates/change';
import type { Module } from '../types';

export function toWorkspace(w: WorkspaceRow): Workspace {
  return {
    ...w,
    billable_default: bool(w.billable_default),
    rounding_min: w.rounding_min as Workspace['rounding_min'],
    rounding_mode: w.rounding_mode as Workspace['rounding_mode'],
    on_rate_change: w.on_rate_change as Workspace['on_rate_change'],
    archived: w.archived === 1,
  };
}

const COLUMNS = [
  'name',
  'color',
  'sort_order',
  'currency',
  'default_hourly_rate',
  'billable_default',
  'rounding_min',
  'rounding_mode',
  'daily_target_min',
  'alert_after_min',
  'tick_interval_min',
  'on_rate_change',
  'archived',
] as const;

type WorkspaceInput = z.infer<typeof WorkspacePatch>;
const toColumns = (i: WorkspaceInput) => ({
  ...i,
  billable_default: bit(i.billable_default),
  archived: bit(i.archived),
  rate_change: undefined,
});

const IdParam = z.object({ id: Id });

export const workspacesModule: Module = {
  name: 'workspaces',
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['workspaces'],
        responses: { 200: json(z.array(Workspace)) },
      }),
      async (c) => {
        const rows = await c.env.ctx.db.all<WorkspaceRow>(
          'SELECT * FROM workspaces ORDER BY sort_order, id',
        );
        return c.json(rows.map(toWorkspace), 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/',
        tags: ['workspaces'],
        request: body(WorkspaceCreate),
        responses: { 201: json(Workspace) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const input = c.req.valid('json');
        const now = ctx.clock.now();
        const cols = { color: '#888888', ...toColumns(input) } as Record<
          string,
          string | number | null | undefined
        >;
        const { sql, params } = setClause(cols, COLUMNS);
        const names = sql.split(', ').map((s) => s.replace(' = ?', ''));
        const row = await uniqueName(
          ctx.db.first<WorkspaceRow>(
            `INSERT INTO workspaces (${names.join(', ')}, created_at, updated_at)
             VALUES (${names.map(() => '?').join(', ')}, ?, ?) RETURNING *`,
            ...params,
            now,
            now,
          ),
        );
        return c.json(toWorkspace(row!), 201);
      },
    );

    app.openapi(
      createRoute({
        method: 'patch',
        path: '/{id}',
        tags: ['workspaces'],
        request: { params: IdParam, ...body(WorkspacePatch) },
        responses: { 200: json(Workspace.extend({ rate_change_result: z.unknown().optional() })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { id } = c.req.valid('param');
        const input = c.req.valid('json');
        const current = await requireWorkspace(ctx, id);
        if (input.archived === true && !current.archived) {
          const others = await ctx.db.first<{ n: number }>(
            'SELECT COUNT(*) AS n FROM workspaces WHERE archived = 0 AND id != ?',
            id,
          );
          if (!others?.n)
            throw conflict('last_workspace', 'Cannot archive the only active workspace');
        }
        const plan = await planRateChange(
          ctx,
          {
            level: 'workspace',
            id,
            rateChanged:
              input.default_hourly_rate !== undefined &&
              input.default_hourly_rate !== current.default_hourly_rate,
            currencyChanged: input.currency !== undefined && input.currency !== current.currency,
          },
          input.rate_change,
        );
        const { sql, params } = setClause(toColumns(input), COLUMNS);
        const update = sql
          ? [
              {
                sql: `UPDATE workspaces SET ${sql}, updated_at = ? WHERE id = ?`,
                params: [...params, ctx.clock.now(), id],
              },
            ]
          : [];
        const result = await uniqueName(runWithPlan(ctx, plan, update, { level: 'workspace', id }));
        return c.json(
          { ...toWorkspace(await requireWorkspace(ctx, id)), rate_change_result: result },
          200,
        );
      },
    );

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/{id}',
        tags: ['workspaces'],
        request: { params: IdParam },
        responses: { 200: json(z.object({ ok: z.literal(true) })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { id } = c.req.valid('param');
        await requireWorkspace(ctx, id);
        // Hard delete only while empty; otherwise archive (§4.4).
        const r = await ctx.db.run(
          `DELETE FROM workspaces WHERE id = ?
             AND NOT EXISTS (SELECT 1 FROM time_entries WHERE workspace_id = ?)
             AND NOT EXISTS (SELECT 1 FROM clients WHERE workspace_id = ?)
             AND NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id = ?)
             AND NOT EXISTS (SELECT 1 FROM period_locks WHERE workspace_id = ?)
             AND (SELECT COUNT(*) FROM workspaces WHERE archived = 0 AND id != ?) > 0`,
          id,
          id,
          id,
          id,
          id,
          id,
        );
        if (r.changes !== 1)
          throw conflict('not_empty', 'Workspace has data or is the only one; archive it instead');
        return c.json({ ok: true as const }, 200);
      },
    );
  },
};
