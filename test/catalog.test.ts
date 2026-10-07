// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings, workspaces, clients and projects (§4, §4.3, §4.4).
import { beforeEach, describe, expect, it } from 'vitest';
import { HOUR, authed, call, db, resetDb, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => {
  await resetDb();
  h = await authed();
});

describe('settings', () => {
  it('returns defaults', async () => {
    const s = await call(h, 'GET', '/api/settings', undefined, 200);
    expect(s).toMatchObject({
      timezone: 'UTC',
      clock_format: '24h',
      on_rate_change: 'ask',
      rounding_min: 0,
    });
  });

  it('validates timezone, currency, locale and rounding server-side', async () => {
    for (const bad of [
      { timezone: 'Mars/Base' },
      { currency: 'XYZ' },
      { locale: 'xx' },
      { rounding_min: 7 },
      { quiet_hours: '25:00-07:00' },
    ]) {
      expect((await h.json('/api/settings', { method: 'PATCH', json: bad })).status).toBe(400);
    }
    const s = await call(
      h,
      'PATCH',
      '/api/settings',
      { timezone: 'America/New_York', locale: 'nb', currency: 'NOK' },
      200,
    );
    expect(s).toMatchObject({ timezone: 'America/New_York', locale: 'nb', currency: 'NOK' });
  });
});

describe('workspaces', () => {
  it('creates, lists, rejects duplicate names and keeps one active', async () => {
    const a = await call(
      h,
      'POST',
      '/api/workspaces',
      { name: 'Self-employed', default_hourly_rate: 100000 },
      201,
    );
    expect(a).toMatchObject({
      name: 'Self-employed',
      color: '#888888',
      archived: false,
      billable_default: null,
    });
    expect(
      (await h.json('/api/workspaces', { method: 'POST', json: { name: 'Self-employed' } })).status,
    ).toBe(409);
    expect(
      (await h.json(`/api/workspaces/${a.id}`, { method: 'PATCH', json: { archived: true } })).body
        .error,
    ).toBe('last_workspace');
    const b = await call(
      h,
      'POST',
      '/api/workspaces',
      { name: 'Employer', billable_default: false },
      201,
    );
    expect(b.billable_default).toBe(false);
    await call(h, 'PATCH', `/api/workspaces/${a.id}`, { archived: true }, 200);
    const list = await call(h, 'GET', '/api/workspaces', undefined, 200);
    expect(list.map((w: { name: string }) => w.name)).toEqual(['Self-employed', 'Employer']);
  });

  it('only hard-deletes empty workspaces', async () => {
    const a = await call(h, 'POST', '/api/workspaces', { name: 'A' }, 201);
    const b = await call(h, 'POST', '/api/workspaces', { name: 'B' }, 201);
    await call(h, 'POST', '/api/clients', { workspace_id: b.id, name: 'X' }, 201);
    expect((await h.json(`/api/workspaces/${b.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await h.json(`/api/workspaces/${a.id}`, { method: 'DELETE' })).status).toBe(200);
  });
});

describe('clients and projects', () => {
  let ws: number;
  beforeEach(async () => {
    ws = (await call(h, 'POST', '/api/workspaces', { name: 'Work' }, 201)).id;
  });

  it('creates clients in the active workspace and rejects duplicates', async () => {
    const c = await call(
      h,
      'POST',
      '/api/clients',
      { name: 'Acme', hourly_rate: 120000, currency: 'EUR' },
      201,
    );
    expect(c).toMatchObject({
      workspace_id: ws,
      name: 'Acme',
      hourly_rate: 120000,
      currency: 'EUR',
    });
    expect((await h.json('/api/clients', { method: 'POST', json: { name: 'Acme' } })).status).toBe(
      409,
    );
    expect(
      (await h.json('/api/clients', { method: 'POST', json: { name: 'Bad', currency: 'eur' } }))
        .status,
    ).toBe(400);
  });

  it('derives the project workspace from its client and blocks cross-workspace clients', async () => {
    const other = (await call(h, 'POST', '/api/workspaces', { name: 'Other' }, 201)).id;
    const c = await call(h, 'POST', '/api/clients', { workspace_id: other, name: 'Acme' }, 201);
    const p = await call(h, 'POST', '/api/projects', { client_id: c.id, name: 'Site' }, 201);
    expect(p.workspace_id).toBe(other);
    const bad = await h.json('/api/projects', {
      method: 'POST',
      json: { workspace_id: ws, client_id: c.id, name: 'X' },
    });
    expect(bad.body.error).toBe('workspace_conflict');
  });

  it('rejects duplicate internal project names (NULL client)', async () => {
    await call(h, 'POST', '/api/projects', { name: 'Admin' }, 201);
    expect(
      (await h.json('/api/projects', { method: 'POST', json: { name: 'Admin' } })).status,
    ).toBe(409);
  });

  it('archives instead of deleting when time exists', async () => {
    const c = await call(h, 'POST', '/api/clients', { name: 'Acme' }, 201);
    const p = await call(h, 'POST', '/api/projects', { client_id: c.id, name: 'Site' }, 201);
    await call(
      h,
      'POST',
      '/api/entries',
      { project_id: p.id, start_at: h.clock.now() - 2 * HOUR, end_at: h.clock.now() - HOUR },
      201,
    );
    expect((await h.json(`/api/projects/${p.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await h.json(`/api/clients/${c.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await call(h, 'PATCH', `/api/clients/${c.id}`, { archived: true }, 200)).archived).toBe(
      true,
    );
  });

  it('moves a project to another client and its entries follow', async () => {
    const a = await call(h, 'POST', '/api/clients', { name: 'A' }, 201);
    const b = await call(h, 'POST', '/api/clients', { name: 'B' }, 201);
    const p = await call(h, 'POST', '/api/projects', { client_id: a.id, name: 'Site' }, 201);
    const e = await call(
      h,
      'POST',
      '/api/entries',
      { project_id: p.id, start_at: h.clock.now() - HOUR, end_at: h.clock.now() },
      201,
    );
    await call(h, 'PATCH', `/api/projects/${p.id}`, { client_id: b.id }, 200);
    expect(
      (
        await db.first<{ client_id: number }>(
          'SELECT client_id FROM time_entries WHERE id = ?',
          e.id,
        )
      )?.client_id,
    ).toBe(b.id);
  });

  it('moves a client with projects and entries to another workspace (§4.4)', async () => {
    const other = (await call(h, 'POST', '/api/workspaces', { name: 'Board' }, 201)).id;
    const c = await call(h, 'POST', '/api/clients', { name: 'Acme' }, 201);
    const p = await call(h, 'POST', '/api/projects', { client_id: c.id, name: 'Site' }, 201);
    const e = await call(
      h,
      'POST',
      '/api/entries',
      { project_id: p.id, start_at: h.clock.now() - HOUR, end_at: h.clock.now() },
      201,
    );
    const moved = await call(h, 'POST', `/api/clients/${c.id}/move`, { workspace_id: other }, 200);
    expect(moved.workspace_id).toBe(other);
    expect(
      (
        await db.first<{ workspace_id: number }>(
          'SELECT workspace_id FROM projects WHERE id = ?',
          p.id,
        )
      )?.workspace_id,
    ).toBe(other);
    expect(
      (
        await db.first<{ workspace_id: number }>(
          'SELECT workspace_id FROM time_entries WHERE id = ?',
          e.id,
        )
      )?.workspace_id,
    ).toBe(other);
  });

  it('blocks moving a client with period-locked time', async () => {
    const other = (await call(h, 'POST', '/api/workspaces', { name: 'Board' }, 201)).id;
    const c = await call(h, 'POST', '/api/clients', { name: 'Acme' }, 201);
    const e = await call(
      h,
      'POST',
      '/api/entries',
      { client_id: c.id, start_at: h.clock.now() - HOUR, end_at: h.clock.now() },
      201,
    );
    const lock = await db.first<{ id: number }>(
      `INSERT INTO period_locks (from_date, to_date, from_at, to_at, timezone, workspace_id, rounding_min, rounding_mode, locked_at)
       VALUES ('2000-01-01', '2100-01-01', 0, 4102444800, 'UTC', ?, 0, 'nearest', 0) RETURNING id`,
      ws,
    );
    await db.run(
      'UPDATE time_entries SET rate_locked_at = 0, period_lock_id = ? WHERE id = ?',
      lock!.id,
      e.id,
    );
    const r = await h.json(`/api/clients/${c.id}/move`, {
      method: 'POST',
      json: { workspace_id: other },
    });
    expect(r.status).toBe(409);
    expect(
      (
        await db.first<{ workspace_id: number }>(
          'SELECT workspace_id FROM clients WHERE id = ?',
          c.id,
        )
      )?.workspace_id,
    ).toBe(ws);
  });
});
