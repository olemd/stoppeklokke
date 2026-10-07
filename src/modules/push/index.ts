// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Push notifications (§8): subscriptions, the cron hook and the "keep the
 * schedule in step with the running entry" listener. Push and webhooks are
 * listeners/hooks, so timer code never knows about them (§15.2).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { badRequest, HttpError } from '../../core/errors';
import { planNotifications, rearm } from '../../core/notify/plan';
import type { PushSubscriptionKeys } from '../../core/ports';
import { settingsFromRows } from '../../core/settings/defs';
import { resolveSetting } from '../../core/settings/resolve';
import { formatHM } from '../../core/time/duration';
import { catalogs } from '../../shared/i18n/catalogs.generated';
import { createTranslator } from '../../shared/i18n/translate';
import { loadLookup } from '../data/repo';
import { stopTimer } from '../entries/service';
import { body, json } from '../http';
import type { Ctx, Module } from '../types';

const Subscribe = z.object({
  endpoint: z
    .url()
    .max(2048)
    .refine((u) => u.startsWith('https://'), 'push endpoints must use https'),
  keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(16).max(32) }),
  label: z.string().max(100).optional(),
});
const Subscription = z.object({
  endpoint: z.string(),
  label: z.string().nullable(),
  created_at: z.number(),
  last_ok_at: z.number().nullable(),
});

interface SubRow extends PushSubscriptionKeys {
  label: string | null;
}

/**
 * Deliver one payload to every subscription. 404/410 → the subscription is
 * gone and is deleted; other errors are logged, no retry (§8.2).
 */
export async function sendToAll(
  ctx: Ctx,
  payload: Record<string, unknown>,
): Promise<{ sent: number; removed: number }> {
  if (!ctx.push) return { sent: 0, removed: 0 };
  const subs = await ctx.db.all<SubRow>(
    'SELECT endpoint, p256dh, auth, label FROM push_subscriptions',
  );
  let sent = 0;
  let removed = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        const status = await ctx.push!.send(s, JSON.stringify(payload), { urgency: 'high' });
        if (status === 404 || status === 410) {
          await ctx.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
          removed++;
        } else if (status >= 200 && status < 300) {
          await ctx.db.run(
            'UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?',
            ctx.clock.now(),
            s.endpoint,
          );
          sent++;
        } else {
          ctx.log.warn('push rejected', { status, endpoint: new URL(s.endpoint).host });
        }
      } catch (err) {
        ctx.log.error('push failed', { err: String(err), endpoint: new URL(s.endpoint).host });
      }
    }),
  );
  return { sent, removed };
}

interface RunningRow {
  id: number;
  start_at: number;
  description: string;
  project_name: string | null;
  client_name: string | null;
  p_billable: number | null;
  p_alert: number | null;
  p_tick: number | null;
  w_alert: number | null;
  w_tick: number | null;
  settings: string;
  sent: string;
}

/**
 * The cron hook (§8.1): one SELECT for the running entry, its overrides,
 * settings and the notification log; then decide, log, send.
 */
export async function pushCron(ctx: Ctx): Promise<void> {
  const row = await ctx.db.first<RunningRow>(
    `SELECT e.id, e.start_at, e.description,
            p.name AS project_name, c.name AS client_name,
            p.alert_after_min AS p_alert, p.tick_interval_min AS p_tick,
            w.alert_after_min AS w_alert, w.tick_interval_min AS w_tick,
            (SELECT json_group_array(json_object('key', key, 'value', value)) FROM settings) AS settings,
            (SELECT json_group_array(kind || ':' || seq) FROM notification_log WHERE entry_id = e.id) AS sent
       FROM time_entries e
       LEFT JOIN projects p ON p.id = e.project_id
       LEFT JOIN clients c ON c.id = e.client_id
       JOIN workspaces w ON w.id = e.workspace_id
      WHERE e.end_at IS NULL`,
  );
  if (!row) return;
  const settings = settingsFromRows(JSON.parse(row.settings) as { key: string; value: string }[]);
  const project = {
    billable_default: row.p_billable,
    alert_after_min: row.p_alert,
    tick_interval_min: row.p_tick,
  };
  const workspace = { alert_after_min: row.w_alert, tick_interval_min: row.w_tick } as never;
  const plan = planNotifications({
    startAt: row.start_at,
    now: ctx.clock.now(),
    alertAfterMin: resolveSetting('alert_after_min', { project, workspace, settings }),
    tickIntervalMin: resolveSetting('tick_interval_min', { project, workspace, settings }),
    idleStopAfterMin: settings.idle_stop_after_min,
    quietHours: settings.quiet_hours,
    timezone: settings.timezone,
    sent: new Set(JSON.parse(row.sent) as string[]),
  });

  const { t } = createTranslator(settings.locale, catalogs);
  const label = row.project_name ?? row.client_name ?? (row.description || t('push.yourTimer'));
  const duration = formatHM(plan.duration);
  const actions = { stop: t('push.stop'), keep: t('push.keep') };
  const stopped = {
    title: t('push.stoppedTitle'),
    body: t('push.stoppedBody', { project: label, duration }),
  };

  if (plan.stopAt !== null) {
    try {
      await stopTimer(ctx, { end_at: plan.stopAt, force: true });
      await sendToAll(ctx, {
        title: t('push.stoppedTitle'),
        body: t('push.autoStoppedBody', { project: label, duration }),
        tag: `stoppeklokke-${row.id}`,
      });
    } catch (err) {
      ctx.log.warn('auto-stop failed', { err: String(err) });
    }
    return;
  }

  const send = async (kind: 'alert' | 'tick', seq: number, title: string, text: string) => {
    // Log first: the primary key makes this idempotent if cron runs twice.
    const r = await ctx.db.run(
      'INSERT OR IGNORE INTO notification_log (entry_id, kind, seq, sent_at) VALUES (?, ?, ?, ?)',
      row.id,
      kind,
      seq,
      ctx.clock.now(),
    );
    if (r.changes !== 1) return;
    await sendToAll(ctx, {
      title,
      body: text,
      tag: `stoppeklokke-${row.id}`,
      entry_id: row.id,
      actions,
      stopped,
    });
    ctx.events.emit({ type: 'alert.sent', entry_id: row.id, kind, seq });
  };
  if (plan.alert)
    await send('alert', 0, t('push.alertTitle'), t('push.alertBody', { project: label, duration }));
  if (plan.tick !== null)
    await send(
      'tick',
      plan.tick,
      t('push.tickTitle'),
      t('push.tickBody', { project: label, duration }),
    );
}

export const pushModule: Module = {
  name: 'push',
  cron: pushCron,

  /** Keep the schedule in step when the running entry's start or project changes. */
  async onEvent(e, ctx) {
    if (e.type !== 'entry.updated' || e.entry.end_at !== null) return;
    const lookup = await loadLookup(ctx);
    const project = e.entry.project_id ? lookup.projects.get(e.entry.project_id as number) : null;
    const workspace = lookup.workspaces.get(e.entry.workspace_id as number);
    const scope = { project, workspace, settings: lookup.settings };
    const r = rearm(
      ctx.clock.now() - (e.entry.start_at as number),
      resolveSetting('alert_after_min', scope),
      resolveSetting('tick_interval_min', scope),
    );
    await ctx.db.run(
      `DELETE FROM notification_log WHERE entry_id = ?
         AND ((kind = 'tick' AND seq > ?) OR (kind = 'alert' AND ?))`,
      e.entry.id as number,
      r.ticksAbove,
      r.clearAlert ? 1 : 0,
    );
  },

  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/vapid-public-key',
        tags: ['push'],
        responses: { 200: json(z.object({ key: z.string().nullable() })) },
      }),
      async (c) =>
        c.json({ key: c.env.ctx.push ? (c.env.ctx.config.VAPID_PUBLIC_KEY ?? null) : null }, 200),
    );

    app.openapi(
      createRoute({
        method: 'get',
        path: '/subscriptions',
        tags: ['push'],
        responses: { 200: json(z.array(Subscription)) },
      }),
      async (c) =>
        c.json(
          await c.env.ctx.db.all<z.infer<typeof Subscription>>(
            'SELECT endpoint, label, created_at, last_ok_at FROM push_subscriptions ORDER BY created_at',
          ),
          200,
        ),
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/subscribe',
        tags: ['push'],
        request: body(Subscribe),
        responses: { 200: json(z.object({ ok: z.literal(true) })) },
      }),
      async (c) => {
        const { endpoint, keys, label } = c.req.valid('json');
        if (new URL(endpoint).origin === c.env.ctx.config.ORIGIN) throw badRequest('bad_endpoint');
        await c.env.ctx.db.run(
          `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
          endpoint,
          keys.p256dh,
          keys.auth,
          label ?? null,
          c.env.ctx.clock.now(),
        );
        return c.json({ ok: true as const }, 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/subscribe',
        tags: ['push'],
        request: body(z.object({ endpoint: z.string().max(2048) })),
        responses: { 200: json(z.object({ ok: z.literal(true) })) },
      }),
      async (c) => {
        await c.env.ctx.db.run(
          'DELETE FROM push_subscriptions WHERE endpoint = ?',
          c.req.valid('json').endpoint,
        );
        return c.json({ ok: true as const }, 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/test',
        tags: ['push'],
        responses: { 200: json(z.object({ sent: z.number(), removed: z.number() })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        if (!ctx.push)
          throw new HttpError(503, 'push_not_configured', 'VAPID keys are not configured');
        const s = settingsFromRows(await ctx.db.all('SELECT key, value FROM settings'));
        const { t } = createTranslator(s.locale, catalogs);
        return c.json(
          await sendToAll(ctx, {
            title: t('push.testTitle'),
            body: t('push.testBody'),
            tag: 'stoppeklokke-test',
          }),
          200,
        );
      },
    );
  },
};
