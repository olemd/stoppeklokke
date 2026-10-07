// SPDX-License-Identifier: AGPL-3.0-or-later
/** Clients (§4): belong to a workspace; optional rate/currency overrides. */
import { createRoute, z } from '@hono/zod-openapi';
import { conflict } from '../../core/errors';
import type { ClientRow } from '../../core/model';
import { Client, ClientCreate, ClientPatch, Id } from '../../shared/schemas';
import { uniqueName } from '../data/errors';
import { activeWorkspaceId, loadSettings, requireClient, requireWorkspace } from '../data/repo';
import { bit, body, json, setClause } from '../http';
import { planRateChange, runWithPlan } from '../rates/change';
import type { Module } from '../types';

export const toClient = (r: ClientRow): Client => ({ ...r, archived: r.archived === 1 });

const IdParam = z.object({ id: Id });
const Ok = z.object({ ok: z.literal(true) });

export const clientsModule: Module = {
  name: 'clients',
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['clients'],
        request: { query: z.object({ workspace_id: Id.optional() }) },
        responses: { 200: json(z.array(Client)) },
      }),
      async (c) => {
        const { workspace_id } = c.req.valid('query');
        const rows = workspace_id
          ? await c.env.ctx.db.all<ClientRow>(
              'SELECT * FROM clients WHERE workspace_id = ? ORDER BY name COLLATE NOCASE',
              workspace_id,
            )
          : await c.env.ctx.db.all<ClientRow>('SELECT * FROM clients ORDER BY name COLLATE NOCASE');
        return c.json(rows.map(toClient), 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/',
        tags: ['clients'],
        request: body(ClientCreate),
        responses: { 201: json(Client) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const input = c.req.valid('json');
        const workspaceId =
          input.workspace_id ?? (await activeWorkspaceId(ctx, await loadSettings(ctx)));
        await requireWorkspace(ctx, workspaceId);
        const now = ctx.clock.now();
        const row = await uniqueName(
          ctx.db.first<ClientRow>(
            `INSERT INTO clients (workspace_id, name, hourly_rate, currency, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
            workspaceId,
            input.name,
            input.hourly_rate ?? null,
            input.currency ?? null,
            now,
            now,
          ),
        );
        return c.json(toClient(row!), 201);
      },
    );

    app.openapi(
      createRoute({
        method: 'patch',
        path: '/{id}',
        tags: ['clients'],
        request: { params: IdParam, ...body(ClientPatch) },
        responses: { 200: json(Client.extend({ rate_change_result: z.unknown().optional() })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { id } = c.req.valid('param');
        const input = c.req.valid('json');
        const current = await requireClient(ctx, id);
        const plan = await planRateChange(
          ctx,
          {
            level: 'client',
            id,
            rateChanged:
              input.hourly_rate !== undefined && input.hourly_rate !== current.hourly_rate,
            currencyChanged: input.currency !== undefined && input.currency !== current.currency,
          },
          input.rate_change,
        );
        const { sql, params } = setClause(
          {
            name: input.name,
            hourly_rate: input.hourly_rate,
            currency: input.currency,
            archived: bit(input.archived),
          },
          ['name', 'hourly_rate', 'currency', 'archived'],
        );
        const update = sql
          ? [
              {
                sql: `UPDATE clients SET ${sql}, updated_at = ? WHERE id = ?`,
                params: [...params, ctx.clock.now(), id],
              },
            ]
          : [];
        const result = await uniqueName(runWithPlan(ctx, plan, update, { level: 'client', id }));
        return c.json(
          { ...toClient(await requireClient(ctx, id)), rate_change_result: result },
          200,
        );
      },
    );

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/{id}',
        tags: ['clients'],
        request: { params: IdParam },
        responses: { 200: json(Ok) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { id } = c.req.valid('param');
        await requireClient(ctx, id);
        const r = await ctx.db.run(
          `DELETE FROM clients WHERE id = ?
             AND NOT EXISTS (SELECT 1 FROM time_entries WHERE client_id = ?)
             AND NOT EXISTS (SELECT 1 FROM projects WHERE client_id = ?)
             AND NOT EXISTS (SELECT 1 FROM period_locks WHERE client_id = ?)`,
          id,
          id,
          id,
          id,
        );
        if (r.changes !== 1)
          throw conflict('not_empty', 'Client has projects or time; archive it instead');
        return c.json({ ok: true as const }, 200);
      },
    );

    // Move a client (with its projects and entries) to another workspace (§4.4).
    app.openapi(
      createRoute({
        method: 'post',
        path: '/{id}/move',
        tags: ['clients'],
        request: { params: IdParam, ...body(z.object({ workspace_id: Id })) },
        responses: { 200: json(Client) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { id } = c.req.valid('param');
        const { workspace_id } = c.req.valid('json');
        const client = await requireClient(ctx, id);
        await requireWorkspace(ctx, workspace_id);
        if (client.workspace_id === workspace_id) return c.json(toClient(client), 200);
        const now = ctx.clock.now();
        // One atomic batch. The first UPDATE is conditional on no period-locked
        // entries; the rest only apply if the client actually moved.
        const moved = '(SELECT workspace_id FROM clients WHERE id = ?) = ?';
        const [first] = await uniqueName(
          ctx.db.batch([
            {
              sql: `UPDATE clients SET workspace_id = ?, updated_at = ? WHERE id = ?
                      AND NOT EXISTS (SELECT 1 FROM time_entries WHERE client_id = ? AND period_lock_id IS NOT NULL)
                      AND NOT EXISTS (SELECT 1 FROM period_locks WHERE client_id = ?)`,
              params: [workspace_id, now, id, id, id],
            },
            {
              sql: `UPDATE projects SET workspace_id = ?, updated_at = ? WHERE client_id = ? AND ${moved}`,
              params: [workspace_id, now, id, id, workspace_id],
            },
            {
              sql: `UPDATE time_entries SET workspace_id = ?, updated_at = ? WHERE client_id = ? AND ${moved}`,
              params: [workspace_id, now, id, id, workspace_id],
            },
          ]),
          'client name in the target workspace',
        );
        if (first?.changes !== 1)
          throw conflict('client_locked', 'The client has period-locked time and cannot be moved');
        return c.json(toClient(await requireClient(ctx, id)), 200);
      },
    );
  },
};
