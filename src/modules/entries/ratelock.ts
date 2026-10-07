// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Manual rate locks (§4.1): lock or release selected entries in bulk, and the
 * 5-minute undo of an automatic "lock" rate change (§4.2 step 6).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { conflict } from '../../core/errors';
import { dateRangeBounds } from '../../core/time/tz';
import { DateStr, Epoch, Id } from '../../shared/schemas';
import { loadSettings } from '../data/repo';
import { body, json } from '../http';
import { freezeRates } from '../rates/change';
import { checkRange } from '../reports/data';
import type { Router } from '../types';

export const UNDO_WINDOW = 300;
const Ids = z.array(z.number().int().positive()).min(1).max(1000);
const LockBody = z.union([
  z.object({ ids: Ids }),
  z.object({
    from: DateStr,
    to: DateStr,
    workspace_id: Id.optional(),
    client_id: Id.optional(),
    project_id: Id.optional(),
  }),
]);
const UnlockBody = z.union([z.object({ ids: Ids }), z.object({ locked_at: Epoch })]);

export function rateLockRoutes(app: Router) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/rate-lock',
      tags: ['entries'],
      request: body(LockBody),
      responses: { 200: json(z.object({ locked: z.number(), locked_at: z.number() })) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const input = c.req.valid('json');
      const settings = await loadSettings(ctx);
      const where = ['e.end_at IS NOT NULL', 'e.rate_locked_at IS NULL'];
      const params: number[] = [];
      if ('ids' in input) {
        where.push(`e.id IN (${input.ids.map(() => '?').join(',')})`);
        params.push(...input.ids);
      } else {
        checkRange(input.from, input.to);
        const { start, end } = dateRangeBounds(input.from, input.to, settings.timezone);
        where.push('e.start_at >= ?', 'e.start_at < ?');
        params.push(start, end);
        for (const k of ['workspace_id', 'client_id', 'project_id'] as const) {
          if (input[k]) {
            where.push(`e.${k} = ?`);
            params.push(input[k]!);
          }
        }
      }
      const now = ctx.clock.now();
      const [r] = await ctx.db.batch([freezeRates(where.join(' AND '), params, settings, now)]);
      return c.json({ locked: r?.changes ?? 0, locked_at: now }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/rate-unlock',
      tags: ['entries'],
      request: body(UnlockBody),
      responses: {
        200: json(z.object({ released: z.number(), skipped_period_locked: z.number() })),
      },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const input = c.req.valid('json');
      let match: string;
      let params: number[];
      if ('ids' in input) {
        match = `id IN (${input.ids.map(() => '?').join(',')})`;
        params = input.ids;
      } else {
        // Undo releases exactly the entries locked by that action, within 5 minutes.
        if (ctx.clock.now() - input.locked_at > UNDO_WINDOW) {
          throw conflict('undo_expired', 'Undo is only possible within 5 minutes');
        }
        match = 'rate_locked_at = ?';
        params = [input.locked_at];
      }
      const [skipped, released] = await ctx.db.batch([
        {
          sql: `SELECT COUNT(*) AS n FROM time_entries WHERE ${match} AND period_lock_id IS NOT NULL`,
          params,
        },
        {
          // Rate locks on period-locked entries are never released here (§4.1).
          sql: `UPDATE time_entries SET rate_locked_at = NULL, locked_rate = NULL, locked_currency = NULL, updated_at = ?
                 WHERE ${match} AND period_lock_id IS NULL AND rate_locked_at IS NOT NULL`,
          params: [ctx.clock.now(), ...params],
        },
      ]);
      return c.json(
        {
          released: released?.changes ?? 0,
          skipped_period_locked: Number((skipped?.rows[0] as { n: number } | undefined)?.n ?? 0),
        },
        200,
      );
    },
  );
}
