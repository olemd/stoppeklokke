// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Personal API tokens (§15.3): `Authorization: Bearer sk_…`, stored hashed,
 * scope read|write, optional expiry. For CLIs, scripts, Home Assistant,
 * Stream Deck, an MCP server, … Managing tokens requires a passkey session.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { randomToken, sha256Hex } from '../../core/crypto';
import { badRequest, notFound } from '../../core/errors';
import { Epoch, Id } from '../../shared/schemas';
import { requireSession, setBearerVerifier } from '../auth/middleware';
import { body, json } from '../http';
import type { AuthInfo, Ctx, Module } from '../types';

export const TOKEN_PREFIX = 'sk_';
const LAST_USED_RESOLUTION = 3600;

const Token = z.object({
  id: z.number(),
  name: z.string(),
  prefix: z.string(),
  scope: z.enum(['read', 'write']),
  expires_at: z.number().nullable(),
  created_at: z.number(),
  last_used_at: z.number().nullable(),
});

/** Resolve a bearer token; also records last use (at most hourly, to avoid a write per request). */
export async function verifyToken(ctx: Ctx, token: string): Promise<AuthInfo | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const now = ctx.clock.now();
  const row = await ctx.db.first<{
    id: number;
    scope: 'read' | 'write';
    expires_at: number | null;
    last_used_at: number | null;
  }>(
    'SELECT id, scope, expires_at, last_used_at FROM tokens_tokens WHERE token_hash = ?',
    await sha256Hex(token),
  );
  if (!row || (row.expires_at !== null && row.expires_at <= now)) return null;
  if (row.last_used_at === null || now - row.last_used_at > LAST_USED_RESOLUTION) {
    ctx.scheduler.waitUntil(
      ctx.db.run('UPDATE tokens_tokens SET last_used_at = ? WHERE id = ?', now, row.id),
    );
  }
  return { kind: 'token', tokenId: row.id, scope: row.scope };
}

setBearerVerifier(verifyToken);

export const tokensModule: Module = {
  name: 'tokens',
  migrations: 'migrations/0003_tokens.sql',
  routes(app) {
    app.use('*', requireSession);

    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['tokens'],
        responses: { 200: json(z.array(Token)) },
      }),
      async (c) =>
        c.json(
          await c.env.ctx.db.all<z.infer<typeof Token>>(
            'SELECT id, name, prefix, scope, expires_at, created_at, last_used_at FROM tokens_tokens ORDER BY created_at',
          ),
          200,
        ),
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/',
        tags: ['tokens'],
        request: body(
          z.object({
            name: z.string().trim().min(1).max(100),
            scope: z.enum(['read', 'write']).default('read'),
            expires_at: Epoch.nullable().optional(),
          }),
        ),
        responses: {
          201: json(Token.extend({ token: z.string() }), 'The token is shown only once'),
        },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { name, scope, expires_at } = c.req.valid('json');
        const now = ctx.clock.now();
        if (expires_at != null && expires_at <= now)
          throw badRequest('expired', 'Expiry must be in the future');
        const token = TOKEN_PREFIX + randomToken(32);
        const row = await ctx.db.first<z.infer<typeof Token>>(
          `INSERT INTO tokens_tokens (name, token_hash, prefix, scope, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id, name, prefix, scope, expires_at, created_at, last_used_at`,
          name,
          await sha256Hex(token),
          token.slice(0, 10),
          scope,
          expires_at ?? null,
          now,
        );
        return c.json({ ...row!, token }, 201);
      },
    );

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/{id}',
        tags: ['tokens'],
        request: { params: z.object({ id: Id }) },
        responses: { 200: json(z.object({ ok: z.literal(true) })) },
      }),
      async (c) => {
        const r = await c.env.ctx.db.run(
          'DELETE FROM tokens_tokens WHERE id = ?',
          c.req.valid('param').id,
        );
        if (r.changes !== 1) throw notFound('token_not_found');
        return c.json({ ok: true as const }, 200);
      },
    );
  },
};
