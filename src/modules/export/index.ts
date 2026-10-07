// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Full data export/import (§9.1): backups and moving between instances.
 *
 * Export: GET /api/export?collection=…&cursor=… returns one page (≤ 500
 * rows); the browser pages through all collections and assembles one JSON
 * file. Paginated so no request exceeds the CPU budget at any data size.
 *
 * Import (session only), into an instance without clients/projects/entries:
 *   POST /api/import/begin → POST /api/import {collection, rows} (≤ 500 rows
 *   per call, dependency order, original IDs kept) → POST /api/import/finish
 *   {counts} which verifies row counts. A failed import is cleaned up with
 *   POST /api/import/wipe and can then be retried.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { conflict } from '../../core/errors';
import { COLLECTIONS, CURRENT_VERSION, FORMAT, MAX_PAGE } from '../../core/export/format';
import { requireSession } from '../auth/middleware';
import { body, json } from '../http';
import { getModules } from '../registry';
import type { Ctx, ExportCollection, Module } from '../types';
import { coreCollections } from './collections';

/** Core collections plus any contributed by other modules (§15.1), in import order. */
export function allCollections(): ExportCollection[] {
  return [...coreCollections, ...getModules().flatMap((m) => m.exportCollections ?? [])].sort(
    (a, b) => a.order - b.order,
  );
}

const IN_PROGRESS = 'import_in_progress';

async function importInProgress(ctx: Ctx): Promise<boolean> {
  return !!(await ctx.db.first(`SELECT 1 FROM settings WHERE key = '${IN_PROGRESS}'`));
}

export const exportModule: Module = {
  name: 'export',
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['export'],
        request: {
          query: z.object({
            collection: z.string().optional(),
            cursor: z.string().max(200).optional(),
          }),
        },
        responses: {
          200: json(
            z.object({
              format: z.literal(FORMAT),
              version: z.number(),
              app_version: z.string(),
              collections: z.array(z.string()),
              collection: z.string().optional(),
              rows: z.array(z.record(z.string(), z.unknown())).optional(),
              next: z.string().nullable().optional(),
            }),
          ),
        },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { collection, cursor } = c.req.valid('query');
        const cols = allCollections();
        const meta = {
          format: FORMAT as typeof FORMAT,
          version: CURRENT_VERSION,
          app_version: ctx.config.APP_VERSION,
          collections: cols.map((x) => x.name),
        };
        if (!collection) return c.json(meta, 200);
        const col = cols.find((x) => x.name === collection);
        if (!col) throw conflict('unknown_collection', `Unknown collection ${collection}`);
        const page = await col.page(ctx, cursor ?? null, MAX_PAGE);
        return c.json(
          { ...meta, collection, rows: page.rows as Record<string, unknown>[], next: page.next },
          200,
        );
      },
    );
  },
};

const Counts = z.record(z.string(), z.number().int().min(0));

export const importModule: Module = {
  name: 'import',
  routes(app) {
    app.use('*', requireSession);

    app.openapi(
      createRoute({
        method: 'post',
        path: '/begin',
        tags: ['export'],
        responses: {
          200: json(z.object({ ok: z.literal(true), collections: z.array(z.string()) })),
        },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const existing = await ctx.db.first<{ n: number }>(
          `SELECT (SELECT COUNT(*) FROM clients) + (SELECT COUNT(*) FROM projects)
                + (SELECT COUNT(*) FROM time_entries) + (SELECT COUNT(*) FROM period_locks) AS n`,
        );
        if ((existing?.n ?? 0) > 0) {
          throw conflict(
            'not_empty',
            'Import only works on an instance without clients, projects or time',
          );
        }
        // The setup wizard's empty workspace is replaced by the imported ones.
        await ctx.db.batch([
          { sql: 'DELETE FROM workspaces', params: [] },
          {
            sql: `INSERT OR REPLACE INTO settings (key, value) VALUES ('${IN_PROGRESS}', 'true')`,
            params: [],
          },
        ]);
        return c.json({ ok: true as const, collections: allCollections().map((x) => x.name) }, 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/',
        tags: ['export'],
        request: body(
          z.object({ collection: z.string(), rows: z.array(z.unknown()).max(MAX_PAGE) }),
        ),
        responses: { 200: json(z.object({ imported: z.number() })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        if (!(await importInProgress(ctx)))
          throw conflict('no_import', 'Call /api/import/begin first');
        const { collection, rows } = c.req.valid('json');
        const col = allCollections().find((x) => x.name === collection);
        if (!col) throw conflict('unknown_collection', `Unknown collection ${collection}`);
        return c.json({ imported: await col.import(ctx, rows) }, 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/finish',
        tags: ['export'],
        request: body(z.object({ counts: Counts })),
        responses: { 200: json(z.object({ ok: z.literal(true), counts: Counts })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        if (!(await importInProgress(ctx))) throw conflict('no_import', 'No import in progress');
        const expected = c.req.valid('json').counts;
        const actual: Record<string, number> = {};
        for (const col of allCollections()) actual[col.name] = await col.count(ctx);
        const mismatch = Object.entries(expected).filter(([k, n]) => actual[k] !== n);
        if (mismatch.length) {
          throw conflict('count_mismatch', 'Imported row counts do not match the file', {
            expected,
            actual,
          });
        }
        await ctx.db.run(`DELETE FROM settings WHERE key = '${IN_PROGRESS}'`);
        return c.json({ ok: true as const, counts: actual }, 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/wipe',
        tags: ['export'],
        responses: { 200: json(z.object({ ok: z.literal(true) })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        // Only an unfinished import can be wiped: this never deletes normal data.
        if (!(await importInProgress(ctx))) throw conflict('no_import', 'No import in progress');
        const now = ctx.clock.now();
        await ctx.db.batch([
          ...[...COLLECTIONS]
            .reverse()
            .filter((n) => n !== 'settings')
            .map((n) => ({ sql: `DELETE FROM ${n}`, params: [] })),
          // Leave a usable instance behind: one empty workspace, flag cleared.
          {
            sql: `INSERT INTO workspaces (name, created_at, updated_at) VALUES ('Work', ?, ?)`,
            params: [now, now],
          },
          { sql: `DELETE FROM settings WHERE key = '${IN_PROGRESS}'`, params: [] },
        ]);
        return c.json({ ok: true as const }, 200);
      },
    );
  },
};
