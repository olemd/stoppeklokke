// SPDX-License-Identifier: AGPL-3.0-or-later
// Cron notifications (§8, §13) with a recording PushSender.
import { beforeEach, describe, expect, it } from 'vitest';
import type { PushSender } from '../src/core/ports';
import { zonedToEpoch } from '../src/core/time/tz';
import { runCron } from '../src/modules/cron';
import { HOUR, authed, call, db, resetDb, type Harness } from './helpers';

interface Sent {
  endpoint: string;
  payload: any;
}

function recorder(status: (endpoint: string) => number = () => 201) {
  const sent: Sent[] = [];
  const sender: PushSender = {
    async send(sub, payload) {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return status(sub.endpoint);
    },
  };
  return { sent, sender };
}

const SUB = {
  endpoint: 'https://push.example.net/send/device-1',
  keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
  label: 'Phone',
};

let h: Harness;
let rec: ReturnType<typeof recorder>;
beforeEach(async () => {
  await resetDb();
  rec = recorder();
  h = await authed({ push: rec.sender });
  h.clock.t = zonedToEpoch(2026, 10, 7, 9, 0, 'Europe/Oslo');
  await call(h, 'PATCH', '/api/settings', { timezone: 'Europe/Oslo' }, 200);
  await call(h, 'POST', '/api/workspaces', { name: 'Work' }, 201);
  await call(h, 'POST', '/api/push/subscribe', SUB, 200);
});

const cron = async () => {
  await runCron(h.ctx);
  await h.settle();
};
const kinds = () => rec.sent.map((s) => s.payload.title);

describe('cron notifications', () => {
  it('ticks after 1 h and alerts after 4 h, each exactly once (§13)', async () => {
    const p = await call(h, 'POST', '/api/projects', { name: 'Website' }, 201);
    await call(h, 'POST', '/api/timer/start', { project_id: p.id }, 200);
    h.clock.advance(59 * 60);
    await cron();
    expect(rec.sent).toHaveLength(0);
    h.clock.advance(60);
    await cron();
    await cron(); // a second run in the same window sends nothing new
    expect(kinds()).toEqual(['Tick tock']);
    expect(rec.sent[0]!.payload).toMatchObject({
      body: 'Tick tock — 1:00 on Website',
      actions: { stop: 'Stop', keep: 'Keep going' },
    });
    h.clock.advance(3 * HOUR);
    await cron();
    await cron();
    expect(kinds()).toEqual(['Tick tock', 'Time for a break?', 'Tick tock']);
    expect(rec.sent[1]!.payload.body).toContain('unreasonably long time: 4:00');
    const log = await db.all<{ kind: string; seq: number }>(
      'SELECT kind, seq FROM notification_log ORDER BY sent_at, kind',
    );
    expect(log.map((l) => `${l.kind}:${l.seq}`).sort()).toEqual(['alert:0', 'tick:1', 'tick:4']);
  });

  it('renders text in the configured language', async () => {
    await call(h, 'PATCH', '/api/settings', { locale: 'nb' }, 200);
    await call(h, 'POST', '/api/timer/start', { description: 'Rapport' }, 200);
    h.clock.advance(HOUR);
    await cron();
    expect(rec.sent[0]!.payload).toMatchObject({
      title: 'Tikk takk',
      body: 'Tikk takk — 1:00 på Rapport',
    });
  });

  it('skips ticks in quiet hours but still alerts', async () => {
    h.clock.t = zonedToEpoch(2026, 10, 7, 19, 30, 'Europe/Oslo');
    await call(h, 'POST', '/api/timer/start', {}, 200);
    h.clock.advance(4 * HOUR);
    await cron();
    expect(kinds()).toEqual(['Time for a break?']);
  });

  it('follows project overrides (tick every 30 min, 0 = off)', async () => {
    const fast = await call(
      h,
      'POST',
      '/api/projects',
      { name: 'Fast', tick_interval_min: 30 },
      201,
    );
    await call(h, 'POST', '/api/timer/start', { project_id: fast.id }, 200);
    h.clock.advance(30 * 60);
    await cron();
    expect(kinds()).toEqual(['Tick tock']);
    await call(h, 'PATCH', `/api/projects/${fast.id}`, { tick_interval_min: 0 }, 200);
    h.clock.advance(30 * 60);
    await cron();
    expect(kinds()).toEqual(['Tick tock']);
  });

  it('recomputes from a start moved back 30 min (§13)', async () => {
    const { entry } = await call(h, 'POST', '/api/timer/start', {}, 200);
    h.clock.advance(45 * 60);
    await cron();
    expect(rec.sent).toHaveLength(0);
    await call(h, 'PATCH', '/api/timer', { start_at: entry.start_at - 30 * 60 }, 200);
    await h.settle();
    await cron();
    expect(rec.sent[0]!.payload.body).toBe('Tick tock — 1:15 on your timer');
  });

  it('re-arms notifications when the start moves later', async () => {
    const { entry } = await call(h, 'POST', '/api/timer/start', {}, 200);
    h.clock.advance(HOUR);
    await cron();
    await call(h, 'PATCH', '/api/timer', { start_at: entry.start_at + 50 * 60 }, 200);
    await h.settle();
    expect(await db.all('SELECT * FROM notification_log')).toEqual([]);
    h.clock.advance(50 * 60);
    await cron();
    expect(kinds()).toEqual(['Tick tock', 'Tick tock']);
  });

  it('auto-stops when idle_stop_after_min is set and notifies', async () => {
    await call(h, 'PATCH', '/api/settings', { idle_stop_after_min: 120 }, 200);
    const { entry } = await call(h, 'POST', '/api/timer/start', {}, 200);
    h.clock.advance(3 * HOUR);
    await cron();
    expect(await call(h, 'GET', '/api/timer')).toBeNull();
    const row = await db.first<{ end_at: number }>(
      'SELECT end_at FROM time_entries WHERE id = ?',
      entry.id,
    );
    expect(row!.end_at - entry.start_at).toBe(2 * HOUR);
    expect(kinds()).toEqual(['Timer stopped']);
  });
});

describe('subscriptions', () => {
  it('lists, tests and removes subscriptions; 404/410 deletes', async () => {
    await call(
      h,
      'POST',
      '/api/push/subscribe',
      { ...SUB, endpoint: 'https://push.example.net/send/gone' },
      200,
    );
    expect(await call(h, 'GET', '/api/push/subscriptions')).toHaveLength(2);
    rec = recorder((e) => (e.endsWith('/gone') ? 410 : 201));
    h.ctx.push = rec.sender;
    expect(await call(h, 'POST', '/api/push/test', undefined, 200)).toEqual({
      sent: 1,
      removed: 1,
    });
    expect(await call(h, 'GET', '/api/push/subscriptions')).toHaveLength(1);
    await call(h, 'DELETE', '/api/push/subscribe', { endpoint: SUB.endpoint }, 200);
    expect(await call(h, 'GET', '/api/push/subscriptions')).toEqual([]);
  });

  it('rejects non-https endpoints', async () => {
    const r = await h.json('/api/push/subscribe', {
      method: 'POST',
      json: { ...SUB, endpoint: 'http://x.example/a' },
    });
    expect(r.status).toBe(400);
  });

  it('reports push as unavailable without VAPID keys', async () => {
    const plain = await authed();
    expect(await call(plain, 'GET', '/api/push/vapid-public-key')).toEqual({ key: null });
    expect((await plain.json('/api/push/test', { method: 'POST' })).status).toBe(503);
  });
});
