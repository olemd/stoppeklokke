// SPDX-License-Identifier: AGPL-3.0-or-later
/** GET /api/rates/impact (§4.2): what a rate change at a level would touch. */
import { createRoute, z } from '@hono/zod-openapi';
import { badRequest } from '../../core/errors';
import { Id } from '../../shared/schemas';
import { json } from '../http';
import type { Module } from '../types';
import { rateImpact } from './change';

const Impact = z.object({
  count: z.number(),
  seconds: z.number(),
  oldest: z.number().nullable(),
  newest: z.number().nullable(),
  current_rate: z.number().nullable(),
  currency: z.string(),
});

export const ratesModule: Module = {
  name: 'rates',
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/impact',
        tags: ['rates'],
        request: {
          query: z.object({
            level: z.enum(['project', 'client', 'workspace', 'default']),
            id: Id.optional(),
            /** Which value is changing; decides which entries inherit it. */
            change: z.enum(['rate', 'currency', 'both']).default('rate'),
          }),
        },
        responses: { 200: json(Impact) },
      }),
      async (c) => {
        const { level, id, change } = c.req.valid('query');
        if (level !== 'default' && !id)
          throw badRequest('id_required', 'id is required for this level');
        const fields = { rate: change !== 'currency', currency: change !== 'rate' };
        return c.json(await rateImpact(c.env.ctx, level, id ?? null, fields), 200);
      },
    );
  },
};
