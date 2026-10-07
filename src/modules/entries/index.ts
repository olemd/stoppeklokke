// SPDX-License-Identifier: AGPL-3.0-or-later
/** Time entries: list, manual entry, edit, delete, continue (§6). */
import { createRoute, z } from '@hono/zod-openapi';
import { badRequest } from '../../core/errors';
import type { EntryRow } from '../../core/model';
import { DATE_RE, addDays, isValidDate, startOfDay } from '../../core/time/tz';
import { Entry, EntryCreate, EntryPatch, Id } from '../../shared/schemas';
import { loadLookup } from '../data/repo';
import { body, json } from '../http';
import type { Module } from '../types';
import { rateLockRoutes } from './ratelock';
import {
  createEntry,
  deleteEntry,
  flagOverlaps,
  getEntry,
  startTimer,
  toEntry,
  updateEntry,
} from './service';

const IdParam = z.object({ id: Id });

/** `from`/`to` accept YYYY-MM-DD (inclusive, in the timezone setting) or epoch seconds. */
function bound(v: string | undefined, tz: string, end: boolean): number | null {
  if (v === undefined) return null;
  if (DATE_RE.test(v)) {
    if (!isValidDate(v)) throw badRequest('invalid_date', `Invalid date: ${v}`);
    return startOfDay(end ? addDays(v, 1) : v, tz);
  }
  if (/^\d+$/.test(v)) return Number(v);
  throw badRequest('invalid_date', `Invalid from/to: ${v}`);
}

export const ListQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  workspace_id: Id.optional(),
  client_id: Id.optional(),
  project_id: Id.optional(),
  q: z.string().max(200).optional(),
  locked: z.enum(['locked', 'unlocked', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
});

export const entriesModule: Module = {
  name: 'entries',
  routes(app) {
    rateLockRoutes(app);
    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['entries'],
        request: { query: ListQuery },
        responses: { 200: json(z.array(Entry)) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const q = c.req.valid('query');
        const lookup = await loadLookup(ctx);
        const tz = lookup.settings.timezone;
        const where: string[] = [];
        const params: (string | number)[] = [];
        const add = (cond: string, ...vals: (string | number)[]) => {
          where.push(cond);
          params.push(...vals);
        };
        const from = bound(q.from, tz, false);
        const to = bound(q.to, tz, true);
        if (from !== null) add('start_at >= ?', from);
        if (to !== null) add('start_at < ?', to);
        if (q.workspace_id) add('workspace_id = ?', q.workspace_id);
        if (q.client_id) add('client_id = ?', q.client_id);
        if (q.project_id) add('project_id = ?', q.project_id);
        if (q.q) add("description LIKE ? ESCAPE '\\'", `%${q.q.replace(/[\\%_]/g, '\\$&')}%`);
        if (q.locked === 'locked') add('period_lock_id IS NOT NULL');
        if (q.locked === 'unlocked') add('period_lock_id IS NULL');
        const rows = await ctx.db.all<EntryRow>(
          `SELECT * FROM time_entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY start_at DESC, id DESC LIMIT ?`,
          ...params,
          q.limit,
        );
        return c.json(
          flagOverlaps(
            rows.map((r) => toEntry(r, lookup)),
            ctx.clock.now(),
          ),
          200,
        );
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/',
        tags: ['entries'],
        request: body(EntryCreate),
        responses: { 201: json(Entry) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const row = await createEntry(ctx, c.req.valid('json'));
        return c.json(toEntry(row, await loadLookup(ctx)), 201);
      },
    );

    app.openapi(
      createRoute({
        method: 'patch',
        path: '/{id}',
        tags: ['entries'],
        request: { params: IdParam, ...body(EntryPatch) },
        responses: { 200: json(Entry) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const entry = await getEntry(ctx, c.req.valid('param').id);
        const row = await updateEntry(ctx, entry, c.req.valid('json'));
        return c.json(toEntry(row, await loadLookup(ctx)), 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/{id}',
        tags: ['entries'],
        request: { params: IdParam },
        responses: { 200: json(z.object({ ok: z.literal(true) })) },
      }),
      async (c) => {
        await deleteEntry(c.env.ctx, c.req.valid('param').id);
        return c.json({ ok: true as const }, 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/{id}/continue',
        tags: ['entries'],
        request: { params: IdParam },
        responses: { 200: json(z.object({ entry: Entry, stopped: Entry.nullable() })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const src = await getEntry(ctx, c.req.valid('param').id);
        const { started, stopped } = await startTimer(ctx, {
          workspace_id: src.workspace_id,
          client_id: src.client_id,
          project_id: src.project_id,
          description: src.description,
          billable: src.billable === 1,
        });
        const lookup = await loadLookup(ctx);
        return c.json(
          { entry: toEntry(started, lookup), stopped: stopped ? toEntry(stopped, lookup) : null },
          200,
        );
      },
    );
  },
};
