// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Period locks (§4.1): freeze a period once it has been invoiced elsewhere.
 * Locking is one D1 batch of set-based statements: create the lock, freeze
 * rates on entries without a rate lock, then attach the entries.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { badRequest, notFound } from '../../core/errors';
import type { EntryRow, PeriodLockRow } from '../../core/model';
import { priceEntries } from '../../core/reports/aggregate';
import { resolveSetting } from '../../core/settings/resolve';
import { addDays, startOfDay } from '../../core/time/tz';
import { DateStr, Id } from '../../shared/schemas';
import { loadLookup, requireClient, requireProject, requireWorkspace } from '../data/repo';
import { body, json } from '../http';
import { freezeRates } from '../rates/change';
import { checkRange } from '../reports/data';
import type { Ctx, Module } from '../types';

const LockInput = z.object({
  workspace_id: Id,
  from_date: DateStr,
  to_date: DateStr,
  client_id: Id.nullable().optional(),
  project_id: Id.nullable().optional(),
});
const LockCreate = LockInput.extend({ note: z.string().max(500).default('') });

const Lock = z.object({
  id: z.number(),
  from_date: z.string(),
  to_date: z.string(),
  from_at: z.number(),
  to_at: z.number(),
  timezone: z.string(),
  workspace_id: z.number(),
  client_id: z.number().nullable(),
  project_id: z.number().nullable(),
  rounding_min: z.number(),
  rounding_mode: z.string(),
  note: z.string(),
  locked_at: z.number(),
  entries: z.number(),
});

const Preview = z.object({
  count: z.number(),
  seconds: z.number(),
  amounts: z.record(z.string(), z.number()),
  already_locked: z.number(),
  running_excluded: z.number(),
});

interface Scope {
  workspace_id: number;
  client_id: number | null;
  project_id: number | null;
  from_at: number;
  to_at: number;
}

/** Validate the lock scope (§4.1) and compute its epoch bounds in the time zone. */
async function resolveScope(
  ctx: Ctx,
  input: z.infer<typeof LockInput>,
  tz: string,
): Promise<Scope> {
  checkRange(input.from_date, input.to_date);
  await requireWorkspace(ctx, input.workspace_id);
  const clientId = input.client_id ?? null;
  const projectId = input.project_id ?? null;
  if (clientId !== null) {
    const c = await requireClient(ctx, clientId);
    if (c.workspace_id !== input.workspace_id)
      throw badRequest('workspace_conflict', 'Client is in another workspace');
  }
  if (projectId !== null) {
    const p = await requireProject(ctx, projectId);
    if (p.workspace_id !== input.workspace_id)
      throw badRequest('workspace_conflict', 'Project is in another workspace');
    if (clientId !== null && p.client_id !== clientId)
      throw badRequest('client_conflict', 'Project belongs to another client');
  }
  return {
    workspace_id: input.workspace_id,
    client_id: clientId,
    project_id: projectId,
    // Inclusive bounds; stored so a later time-zone change never moves the lock.
    from_at: startOfDay(input.from_date, tz),
    to_at: startOfDay(addDays(input.to_date, 1), tz) - 1,
  };
}

/** WHERE for entries inside a scope, with an optional table alias. */
function scopeWhere(s: Scope, alias = ''): { where: string; params: number[] } {
  const a = alias ? `${alias}.` : '';
  const parts = [`${a}workspace_id = ?`, `${a}start_at BETWEEN ? AND ?`];
  const params = [s.workspace_id, s.from_at, s.to_at];
  if (s.client_id !== null) {
    parts.push(`${a}client_id = ?`);
    params.push(s.client_id);
  }
  if (s.project_id !== null) {
    parts.push(`${a}project_id = ?`);
    params.push(s.project_id);
  }
  return { where: parts.join(' AND '), params };
}

export async function listLocks(ctx: Ctx, workspaceId?: number) {
  return ctx.db.all<z.infer<typeof Lock>>(
    `SELECT l.*, (SELECT COUNT(*) FROM time_entries e WHERE e.period_lock_id = l.id) AS entries
       FROM period_locks l ${workspaceId ? 'WHERE l.workspace_id = ?' : ''}
      ORDER BY l.from_at DESC, l.id DESC`,
    ...(workspaceId ? [workspaceId] : []),
  );
}

export const locksModule: Module = {
  name: 'locks',
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['locks'],
        request: { query: z.object({ workspace_id: Id.optional() }) },
        responses: { 200: json(z.array(Lock)) },
      }),
      async (c) => c.json(await listLocks(c.env.ctx, c.req.valid('query').workspace_id), 200),
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/preview',
        tags: ['locks'],
        request: body(LockInput),
        responses: { 200: json(Preview) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const lookup = await loadLookup(ctx);
        const scope = await resolveScope(ctx, c.req.valid('json'), lookup.settings.timezone);
        const { where, params } = scopeWhere(scope);
        const [rows, counts] = await Promise.all([
          ctx.db.all<EntryRow>(
            `SELECT * FROM time_entries WHERE ${where} AND end_at IS NOT NULL AND period_lock_id IS NULL`,
            ...params,
          ),
          ctx.db.first<{ locked: number; running: number }>(
            `SELECT SUM(period_lock_id IS NOT NULL) AS locked, SUM(end_at IS NULL) AS running
               FROM time_entries WHERE ${where}`,
            ...params,
          ),
        ]);
        const priced = priceEntries(rows, lookup, new Map());
        const amounts: Record<string, number> = {};
        for (const p of priced)
          if (p.amount !== null) amounts[p.currency] = (amounts[p.currency] ?? 0) + p.amount;
        return c.json(
          {
            count: priced.length,
            seconds: priced.reduce((a, p) => a + p.seconds, 0),
            amounts,
            already_locked: counts?.locked ?? 0,
            running_excluded: counts?.running ?? 0,
          },
          200,
        );
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/',
        tags: ['locks'],
        request: body(LockCreate),
        responses: { 201: json(Lock) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const input = c.req.valid('json');
        const lookup = await loadLookup(ctx);
        const tz = lookup.settings.timezone;
        const scope = await resolveScope(ctx, input, tz);
        const workspace = lookup.workspaces.get(scope.workspace_id);
        const roundingMin = resolveSetting('rounding_min', {
          workspace,
          settings: lookup.settings,
        });
        const roundingMode = resolveSetting('rounding_mode', {
          workspace,
          settings: lookup.settings,
        });
        const now = ctx.clock.now();
        const aliased = scopeWhere(scope, 'e');
        const plain = scopeWhere(scope);
        // One atomic batch. D1 serialises writes, so MAX(id) is the lock just inserted.
        await ctx.db.batch([
          {
            sql: `INSERT INTO period_locks (from_date, to_date, from_at, to_at, timezone, workspace_id, client_id,
                                            project_id, rounding_min, rounding_mode, note, locked_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              input.from_date,
              input.to_date,
              scope.from_at,
              scope.to_at,
              tz,
              scope.workspace_id,
              scope.client_id,
              scope.project_id,
              roundingMin,
              roundingMode,
              input.note,
              now,
            ],
          },
          // An existing rate lock is kept: it is already frozen.
          freezeRates(
            `${aliased.where} AND e.end_at IS NOT NULL AND e.rate_locked_at IS NULL AND e.period_lock_id IS NULL`,
            aliased.params,
            lookup.settings,
            now,
          ),
          {
            sql: `UPDATE time_entries SET period_lock_id = (SELECT MAX(id) FROM period_locks), updated_at = ?
                   WHERE ${plain.where} AND end_at IS NOT NULL AND period_lock_id IS NULL`,
            params: [now, ...plain.params],
          },
        ]);
        const lock = (await listLocks(ctx)).find(
          (l) => l.locked_at === now && l.from_at === scope.from_at,
        )!;
        ctx.events.emit({ type: 'lock.created', lock: { ...lock } });
        return c.json(lock, 201);
      },
    );

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/{id}',
        tags: ['locks'],
        request: {
          params: z.object({ id: Id }),
          query: z.object({ release_rates: z.enum(['0', '1']).default('0') }),
        },
        responses: { 200: json(z.object({ ok: z.literal(true), released: z.number() })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { id } = c.req.valid('param');
        const release = c.req.valid('query').release_rates === '1';
        const lock = await ctx.db.first<PeriodLockRow>(
          'SELECT * FROM period_locks WHERE id = ?',
          id,
        );
        if (!lock) throw notFound('lock_not_found');
        const [upd] = await ctx.db.batch([
          {
            sql: `UPDATE time_entries SET period_lock_id = NULL, updated_at = ?
                  ${release ? ', rate_locked_at = NULL, locked_rate = NULL, locked_currency = NULL' : ''}
                  WHERE period_lock_id = ?`,
            params: [ctx.clock.now(), id],
          },
          { sql: 'DELETE FROM period_locks WHERE id = ?', params: [id] },
        ]);
        ctx.events.emit({ type: 'lock.deleted', id });
        return c.json({ ok: true as const, released: upd?.changes ?? 0 }, 200);
      },
    );
  },
};
