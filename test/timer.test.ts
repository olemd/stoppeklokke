// SPDX-License-Identifier: AGPL-3.0-or-later
// The stopwatch (§6) and its edge cases.
import { beforeEach, describe, expect, it } from 'vitest';
import { HOUR, authed, call, db, resetDb, type Harness } from './helpers';

let h: Harness;
let ws: number;
beforeEach(async () => {
  await resetDb();
  h = await authed();
  ws = (await call(h, 'POST', '/api/workspaces', { name: 'Work' }, 201)).id;
});

async function lockAll(workspaceId: number, fromAt: number, toAt: number) {
  return (await db.first<{ id: number }>(
    `INSERT INTO period_locks (from_date, to_date, from_at, to_at, timezone, workspace_id, rounding_min, rounding_mode, note, locked_at)
     VALUES ('2026-01-01', '2026-01-31', ?, ?, 'UTC', ?, 0, 'nearest', 'INV-1', 0) RETURNING id`,
    fromAt,
    toAt,
    workspaceId,
  ))!.id;
}

describe('timer', () => {
  it('starts, reports and stops', async () => {
    expect(await call(h, 'GET', '/api/timer', undefined, 200)).toBeNull();
    const { entry } = await call(h, 'POST', '/api/timer/start', { description: 'Coding' }, 200);
    expect(entry).toMatchObject({
      workspace_id: ws,
      description: 'Coding',
      end_at: null,
      billable: true,
    });
    expect((await call(h, 'GET', '/api/timer', undefined, 200)).id).toBe(entry.id);
    h.clock.advance(HOUR);
    const stopped = await call(h, 'POST', '/api/timer/stop', {}, 200);
    expect(stopped.entry.end_at - stopped.entry.start_at).toBe(HOUR);
    expect(await call(h, 'GET', '/api/timer', undefined, 200)).toBeNull();
    expect((await h.json('/api/timer/stop', { method: 'POST', json: {} })).body.error).toBe(
      'no_timer',
    );
  });

  it('stops the running timer atomically when a new one starts, without overlap', async () => {
    const first = (await call(h, 'POST', '/api/timer/start', { description: 'A' }, 200)).entry;
    h.clock.advance(1800);
    const { entry, stopped } = await call(h, 'POST', '/api/timer/start', { description: 'B' }, 200);
    expect(stopped.id).toBe(first.id);
    expect(stopped.end_at).toBe(entry.start_at);
    const running = await db.all('SELECT id FROM time_entries WHERE end_at IS NULL');
    expect(running).toHaveLength(1);
    const kinds = h.events.map((e) => e.type);
    expect(kinds).toEqual(['timer.started', 'timer.stopped', 'timer.started']);
  });

  it('enforces a single running timer at the database level', async () => {
    await call(h, 'POST', '/api/timer/start', {}, 200);
    await expect(
      db.run(
        'INSERT INTO time_entries (workspace_id, start_at, created_at, updated_at) VALUES (?, 1, 1, 1)',
        ws,
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('rejects start times more than 5 minutes in the future', async () => {
    const r = await h.json('/api/timer/start', {
      method: 'POST',
      json: { start_at: h.clock.now() + 301 },
    });
    expect(r.body.error).toBe('in_future');
    await call(h, 'POST', '/api/timer/start', { start_at: h.clock.now() + 300 }, 200);
  });

  it('asks before stopping a timer that ran more than 24 hours', async () => {
    await call(h, 'POST', '/api/timer/start', {}, 200);
    h.clock.advance(25 * HOUR);
    const r = await h.json('/api/timer/stop', { method: 'POST', json: {} });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'too_long', duration: 25 * HOUR });
    const corrected = await call(
      h,
      'POST',
      '/api/timer/stop',
      { end_at: h.clock.now() - 20 * HOUR },
      200,
    );
    expect(corrected.entry.end_at - corrected.entry.start_at).toBe(5 * HOUR);
  });

  it('keeps a >24 h timer with force', async () => {
    await call(h, 'POST', '/api/timer/start', {}, 200);
    h.clock.advance(25 * HOUR);
    await call(h, 'POST', '/api/timer/stop', { force: true }, 200);
  });

  it('edits the running entry in place: project and start moved back 30 min (§13)', async () => {
    const c = await call(h, 'POST', '/api/clients', { name: 'Acme' }, 201);
    const p = await call(h, 'POST', '/api/projects', { client_id: c.id, name: 'Site' }, 201);
    const { entry } = await call(h, 'POST', '/api/timer/start', {}, 200);
    const patched = await call(
      h,
      'PATCH',
      '/api/timer',
      { project_id: p.id, start_at: entry.start_at - 1800 },
      200,
    );
    expect(patched).toMatchObject({
      project_id: p.id,
      client_id: c.id,
      start_at: entry.start_at - 1800,
      end_at: null,
    });
    expect(
      (await h.json('/api/timer', { method: 'PATCH', json: { end_at: h.clock.now() } })).status,
    ).toBe(400);
  });

  it('discards the running entry', async () => {
    await call(h, 'POST', '/api/timer/start', {}, 200);
    await call(h, 'POST', '/api/timer/discard', undefined, 200);
    expect(await db.first('SELECT 1 FROM time_entries')).toBeNull();
  });

  it('starts in another workspace without changing the active one (§4.4)', async () => {
    const other = (
      await call(h, 'POST', '/api/workspaces', { name: 'Employer', billable_default: false }, 201)
    ).id;
    await call(h, 'PATCH', '/api/settings', { active_workspace_id: ws }, 200);
    const c = await call(h, 'POST', '/api/clients', { workspace_id: other, name: 'Boss' }, 201);
    const { entry } = await call(h, 'POST', '/api/timer/start', { client_id: c.id }, 200);
    expect(entry).toMatchObject({ workspace_id: other, billable: false });
    expect((await call(h, 'GET', '/api/settings')).active_workspace_id).toBe(ws);
  });

  it('applies billable defaults: project overrides workspace', async () => {
    const off = (
      await call(h, 'POST', '/api/workspaces', { name: 'Off', billable_default: false }, 201)
    ).id;
    const p = await call(
      h,
      'POST',
      '/api/projects',
      { workspace_id: off, name: 'Billable one', billable_default: true },
      201,
    );
    expect(
      (await call(h, 'POST', '/api/timer/start', { workspace_id: off }, 200)).entry.billable,
    ).toBe(false);
    h.clock.advance(60);
    expect(
      (await call(h, 'POST', '/api/timer/start', { project_id: p.id }, 200)).entry.billable,
    ).toBe(true);
  });

  it('continues an entry with the same client/project/description', async () => {
    const c = await call(h, 'POST', '/api/clients', { name: 'Acme' }, 201);
    const e = await call(
      h,
      'POST',
      '/api/entries',
      {
        client_id: c.id,
        description: 'Review',
        start_at: h.clock.now() - 2 * HOUR,
        end_at: h.clock.now() - HOUR,
      },
      201,
    );
    const { entry } = await call(h, 'POST', `/api/entries/${e.id}/continue`, undefined, 200);
    expect(entry).toMatchObject({
      client_id: c.id,
      description: 'Review',
      end_at: null,
      start_at: h.clock.now(),
    });
  });
});

describe('timer and period locks (§6)', () => {
  it('rejects starting a timer inside a locked period', async () => {
    await lockAll(ws, h.clock.now() - 10 * HOUR, h.clock.now() + HOUR);
    const r = await h.json('/api/timer/start', { method: 'POST', json: {} });
    expect(r.status).toBe(409);
    expect(r.body.lock.note).toBe('INV-1');
  });

  it('offers to cut at the lock boundary when the period was locked while running', async () => {
    const { entry } = await call(h, 'POST', '/api/timer/start', {}, 200);
    const toAt = entry.start_at + HOUR;
    await lockAll(ws, entry.start_at - HOUR, toAt);
    h.clock.advance(3 * HOUR);
    const r = await h.json('/api/timer/stop', { method: 'POST', json: {} });
    expect(r.status).toBe(409);
    expect(r.body.lock).toMatchObject({ to_at: toAt });
    const cut = await call(h, 'POST', '/api/timer/stop', { cut_at_lock: true }, 200);
    expect(cut.entry).toMatchObject({ start_at: toAt + 1, end_at: h.clock.now() });
  });

  it('discards the timer entirely if all of it is inside the lock', async () => {
    const { entry } = await call(h, 'POST', '/api/timer/start', {}, 200);
    h.clock.advance(HOUR);
    await lockAll(ws, entry.start_at - HOUR, h.clock.now() + HOUR);
    const cut = await call(h, 'POST', '/api/timer/stop', { cut_at_lock: true }, 200);
    expect(cut).toEqual({ entry: null, discarded: true });
  });
});
