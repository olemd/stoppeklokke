// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Description autocomplete (§7.1): suggestions from the last 90 days, ranked
 * by the selected project first, then prefix before substring matches, then
 * frequency and recency. Each suggestion carries the client/project last used
 * with it, so picking one can fill those in. Max 10 results, one query.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { Id } from '../../shared/schemas';
import { json } from '../http';
import type { Module } from '../types';

const Suggestion = z.object({
  description: z.string(),
  workspace_id: z.number(),
  client_id: z.number().nullable(),
  project_id: z.number().nullable(),
  uses: z.number(),
  last_used: z.number(),
});

const WINDOW = 90 * 86400;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

export const suggestionsModule: Module = {
  name: 'suggestions',
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/descriptions',
        tags: ['suggestions'],
        request: {
          query: z.object({ q: z.string().max(200).default(''), project_id: Id.optional() }),
        },
        responses: { 200: json(z.array(Suggestion)) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { q, project_id } = c.req.valid('query');
        const since = ctx.clock.now() - WINDOW;
        const term = escapeLike(q.trim());
        // SQLite returns the bare columns (workspace/client/project) from the
        // row that holds MAX(start_at), i.e. the most recent use.
        const rows = await ctx.db.all<z.infer<typeof Suggestion>>(
          `SELECT description, workspace_id, client_id, project_id,
                  MAX(start_at) AS last_used, COUNT(*) AS uses
             FROM time_entries
            WHERE start_at >= ? AND description != '' AND description LIKE ? ESCAPE '\\'
            GROUP BY description
            ORDER BY SUM(project_id IS ?) > 0 DESC,
                     description LIKE ? ESCAPE '\\' DESC,
                     COUNT(*) + 5.0 * (MAX(start_at) - ?) / ? DESC
            LIMIT 10`,
          since,
          `%${term}%`,
          project_id ?? -1,
          `${term}%`,
          since,
          WINDOW,
        );
        return c.json(rows, 200);
      },
    );
  },
};
