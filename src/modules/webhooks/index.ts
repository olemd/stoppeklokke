// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Outgoing webhooks (§15.3): a listener on domain events (§15.2), so timer
 * and entry code never know webhooks exist. Each delivery is a JSON POST
 * signed with HMAC-SHA256; it runs in the background (waitUntil) with no
 * retry queue in v1 — failures are recorded on the hook and logged.
 *
 * Signature: `X-Stoppeklokke-Signature: sha256=<hex>` over
 * `<X-Stoppeklokke-Timestamp>.<raw body>`, so receivers can reject replays.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { hmacSha256Hex, randomToken } from '../../core/crypto';
import { notFound } from '../../core/errors';
import { DOMAIN_EVENT_TYPES, type DomainEvent } from '../../core/events';
import { Id } from '../../shared/schemas';
import { requireSession } from '../auth/middleware';
import { body, json } from '../http';
import type { Ctx, Module } from '../types';

const EventType = z.enum(DOMAIN_EVENT_TYPES as [string, ...string[]]);
const DELIVERY_TIMEOUT_MS = 10_000;

const Hook = z.object({
  id: z.number(),
  url: z.string(),
  events: z.array(z.string()),
  active: z.boolean(),
  created_at: z.number(),
  last_at: z.number().nullable(),
  last_status: z.number().nullable(),
  last_error: z.string().nullable(),
});

interface HookRow {
  id: number;
  url: string;
  events: string;
  secret: string;
  active: number;
  created_at: number;
  last_at: number | null;
  last_status: number | null;
  last_error: string | null;
}

const toHook = (r: HookRow) => ({
  id: r.id,
  url: r.url,
  events: JSON.parse(r.events) as string[],
  active: r.active === 1,
  created_at: r.created_at,
  last_at: r.last_at,
  last_status: r.last_status,
  last_error: r.last_error,
});

/** POST one event to one hook and record the outcome. */
export async function deliver(
  ctx: Ctx,
  hook: HookRow,
  event: DomainEvent | { type: 'ping' },
): Promise<number> {
  const now = ctx.clock.now();
  const { type, ...data } = event;
  const payload = JSON.stringify({ id: crypto.randomUUID(), event: type, sent_at: now, data });
  let status = 0;
  let error: string | null = null;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Stoppeklokke-Webhook/1',
        'x-stoppeklokke-event': type,
        'x-stoppeklokke-timestamp': String(now),
        'x-stoppeklokke-signature': `sha256=${await hmacSha256Hex(hook.secret, `${now}.${payload}`)}`,
      },
      body: payload,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      redirect: 'manual',
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = String(err).slice(0, 200);
    ctx.log.warn('webhook failed', { hook: hook.id, err: error });
  }
  await ctx.db.run(
    'UPDATE webhooks_hooks SET last_at = ?, last_status = ?, last_error = ? WHERE id = ?',
    now,
    status,
    error,
    hook.id,
  );
  return status;
}

const HttpsUrl = z
  .url()
  .max(2048)
  .refine((u) => u.startsWith('https://'), 'webhook URLs must use https');

export const webhooksModule: Module = {
  name: 'webhooks',
  migrations: 'migrations/0004_webhooks.sql',

  async onEvent(e, ctx) {
    const hooks = await ctx.db.all<HookRow>('SELECT * FROM webhooks_hooks WHERE active = 1');
    await Promise.all(
      hooks
        .filter((h) => (JSON.parse(h.events) as string[]).includes(e.type))
        .map((h) => deliver(ctx, h, e)),
    );
  },

  routes(app) {
    app.use('*', requireSession);

    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['webhooks'],
        responses: { 200: json(z.array(Hook)) },
      }),
      async (c) =>
        c.json(
          (await c.env.ctx.db.all<HookRow>('SELECT * FROM webhooks_hooks ORDER BY id')).map(toHook),
          200,
        ),
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/',
        tags: ['webhooks'],
        request: body(z.object({ url: HttpsUrl, events: z.array(EventType).min(1) })),
        responses: {
          201: json(Hook.extend({ secret: z.string() }), 'The secret is shown only once'),
        },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { url, events } = c.req.valid('json');
        const secret = `whsec_${randomToken(24)}`;
        const row = await ctx.db.first<HookRow>(
          'INSERT INTO webhooks_hooks (url, events, secret, created_at) VALUES (?, ?, ?, ?) RETURNING *',
          url,
          JSON.stringify([...new Set(events)]),
          secret,
          ctx.clock.now(),
        );
        return c.json({ ...toHook(row!), secret }, 201);
      },
    );

    app.openapi(
      createRoute({
        method: 'patch',
        path: '/{id}',
        tags: ['webhooks'],
        request: {
          params: z.object({ id: Id }),
          ...body(
            z.object({
              url: HttpsUrl.optional(),
              events: z.array(EventType).min(1).optional(),
              active: z.boolean().optional(),
            }),
          ),
        },
        responses: { 200: json(Hook) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { id } = c.req.valid('param');
        const p = c.req.valid('json');
        const row = await ctx.db.first<HookRow>(
          `UPDATE webhooks_hooks SET url = COALESCE(?, url), events = COALESCE(?, events), active = COALESCE(?, active)
            WHERE id = ? RETURNING *`,
          p.url ?? null,
          p.events ? JSON.stringify([...new Set(p.events)]) : null,
          p.active === undefined ? null : p.active ? 1 : 0,
          id,
        );
        if (!row) throw notFound('webhook_not_found');
        return c.json(toHook(row), 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/{id}',
        tags: ['webhooks'],
        request: { params: z.object({ id: Id }) },
        responses: { 200: json(z.object({ ok: z.literal(true) })) },
      }),
      async (c) => {
        const r = await c.env.ctx.db.run(
          'DELETE FROM webhooks_hooks WHERE id = ?',
          c.req.valid('param').id,
        );
        if (r.changes !== 1) throw notFound('webhook_not_found');
        return c.json({ ok: true as const }, 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/{id}/test',
        tags: ['webhooks'],
        request: { params: z.object({ id: Id }) },
        responses: { 200: json(z.object({ status: z.number() })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const hook = await ctx.db.first<HookRow>(
          'SELECT * FROM webhooks_hooks WHERE id = ?',
          c.req.valid('param').id,
        );
        if (!hook) throw notFound('webhook_not_found');
        const status = await deliver(ctx, hook, { type: 'ping' });
        return c.json({ status }, 200);
      },
    );
  },
};
