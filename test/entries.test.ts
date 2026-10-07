// SPDX-License-Identifier: AGPL-3.0-or-later
// Manual entries, derivation, validation and lock rules (§4, §4.1, §6).
import { beforeEach, describe, expect, it } from 'vitest';
import { HOUR, authed, call, db, resetDb, type Harness } from './helpers';

let h: Harness;
let ws: number;
let now: number;
beforeEach(async () => {
  await resetDb();
  h = await authed();
  now = h.clock.now();
  ws = (await call(h, 'POST', '/api/workspaces', { name: 'Work' }, 201)).id;
});

const entry = (extra: Record<string, unknown> = {}) => ({
  start_at: now - 2 * HOUR,
  end_at: now - HOUR,
  ...extra,
});

describe('manual entries', () => {
  it('derives client and workspace from the project', async () => {
    const other = (await call(h, 'POST', '/api/workspaces', { name: 'Other' }, 201)).id;
    const c = await call(h, 'POST', '/api/clients', { workspace_id: other, name: 'Acme' }, 201);
    const p = await call(h, 'POST', '/api/projects', { client_id: c.id, name: 'Site' }, 201);
    const e = await call(h, 'POST', '/api/entries', entry({ project_id: p.id }), 201);
    expect(e).toMatchObject({ project_id: p.id, client_id: c.id, workspace_id: other });
  });

  it('rejects conflicting client or workspace with 400', async () => {
    const c = await call(h, 'POST', '/api/clients', { name: 'Acme' }, 201);
    const d = await call(h, 'POST', '/api/clients', { name: 'Other' }, 201);
    const p = await call(h, 'POST', '/api/projects', { client_id: c.id, name: 'Site' }, 201);
    const other = (await call(h, 'POST', '/api/workspaces', { name: 'X' }, 201)).id;
    expect(
      (
        await h.json('/api/entries', {
          method: 'POST',
          json: entry({ project_id: p.id, client_id: d.id }),
        })
      ).body.error,
    ).toBe('client_conflict');
    expect(
      (
        await h.json('/api/entries', {
          method: 'POST',
          json: entry({ client_id: c.id, workspace_id: other }),
        })
      ).body.error,
    ).toBe('workspace_conflict');
  });

  it('allows uncategorised entries in a workspace', async () => {
    const e = await call(h, 'POST', '/api/entries', entry({ description: 'Email' }), 201);
    expect(e).toMatchObject({
      workspace_id: ws,
      client_id: null,
      project_id: null,
      rate: null,
      rate_source: null,
    });
  });

  it('validates times', async () => {
    expect(
      (await h.json('/api/entries', { method: 'POST', json: entry({ end_at: now - 3 * HOUR }) }))
        .body.error,
    ).toBe('end_before_start');
    expect(
      (await h.json('/api/entries', { method: 'POST', json: entry({ end_at: now + 600 }) })).body
        .error,
    ).toBe('in_future');
    const long = { start_at: now - 30 * HOUR, end_at: now - HOUR };
    expect((await h.json('/api/entries', { method: 'POST', json: long })).body.error).toBe(
      'too_long',
    );
    await call(h, 'POST', '/api/entries', { ...long, force: true }, 201);
  });

  it('edits and deletes entries; moving changes the derived client', async () => {
    const c = await call(h, 'POST', '/api/clients', { name: 'Acme' }, 201);
    const e = await call(h, 'POST', '/api/entries', entry(), 201);
    const patched = await call(
      h,
      'PATCH',
      `/api/entries/${e.id}`,
      { client_id: c.id, description: 'x', billable: false },
      200,
    );
    expect(patched).toMatchObject({ client_id: c.id, description: 'x', billable: false });
    await call(h, 'DELETE', `/api/entries/${e.id}`, undefined, 200);
    expect((await h.json(`/api/entries/${e.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('lists by date range in the configured time zone, with search and overlap flags', async () => {
    await call(h, 'PATCH', '/api/settings', { timezone: 'Europe/Oslo' }, 200);
    const day = Date.parse('2026-09-15T00:00:00+02:00') / 1000;
    h.clock.t = day + 20 * HOUR;
    now = h.clock.now();
    const a = await call(
      h,
      'POST',
      '/api/entries',
      { description: 'Design review', start_at: day + 9 * HOUR, end_at: day + 11 * HOUR },
      201,
    );
    const b = await call(
      h,
      'POST',
      '/api/entries',
      { description: 'Coding', start_at: day + 10 * HOUR, end_at: day + 12 * HOUR },
      201,
    );
    await call(
      h,
      'POST',
      '/api/entries',
      { description: 'Yesterday', start_at: day - 2 * HOUR, end_at: day - HOUR },
      201,
    );

    const list = await call(h, 'GET', '/api/entries?from=2026-09-15&to=2026-09-15', undefined, 200);
    expect(list.map((e: { id: number }) => e.id)).toEqual([b.id, a.id]);
    expect(list.every((e: { overlaps: boolean }) => e.overlaps)).toBe(true);
    const search = await call(h, 'GET', '/api/entries?q=review', undefined, 200);
    expect(search.map((e: { id: number }) => e.id)).toEqual([a.id]);
    expect(await call(h, 'GET', '/api/entries?q=%25', undefined, 200)).toEqual([]);
    expect((await h.json('/api/entries?from=2026-02-30')).status).toBe(400);
  });
});

describe('period-locked entries (§4.1)', () => {
  let lockId: number;
  let e: { id: number };
  beforeEach(async () => {
    e = await call(h, 'POST', '/api/entries', entry(), 201);
    lockId = (await db.first<{ id: number }>(
      `INSERT INTO period_locks (from_date, to_date, from_at, to_at, timezone, workspace_id, rounding_min, rounding_mode, locked_at)
       VALUES ('x', 'y', ?, ?, 'UTC', ?, 0, 'nearest', 0) RETURNING id`,
      now - 10 * HOUR,
      now - 30 * 60,
      ws,
    ))!.id;
    await db.run(
      'UPDATE time_entries SET rate_locked_at = 0, period_lock_id = ? WHERE id = ?',
      lockId,
      e.id,
    );
  });

  it('cannot be edited or deleted', async () => {
    expect(
      (await h.json(`/api/entries/${e.id}`, { method: 'PATCH', json: { description: 'x' } })).body
        .error,
    ).toBe('entry_locked');
    expect((await h.json(`/api/entries/${e.id}`, { method: 'DELETE' })).status).toBe(409);
  });

  it('rejects new manual entries inside the locked period and scope', async () => {
    const r = await h.json('/api/entries', {
      method: 'POST',
      json: { start_at: now - 5 * HOUR, end_at: now - 4 * HOUR },
    });
    expect(r.body.error).toBe('locked_period');
    // Outside the period is fine.
    await call(h, 'POST', '/api/entries', { start_at: now - 20 * 60, end_at: now - 10 * 60 }, 201);
  });

  it('does not cover other workspaces or narrower scopes', async () => {
    const other = (await call(h, 'POST', '/api/workspaces', { name: 'Other' }, 201)).id;
    await call(
      h,
      'POST',
      '/api/entries',
      { workspace_id: other, start_at: now - 5 * HOUR, end_at: now - 4 * HOUR },
      201,
    );
  });

  it('blocks moving an unlocked entry into the locked period', async () => {
    const free = await call(
      h,
      'POST',
      '/api/entries',
      { start_at: now - 20 * 60, end_at: now - 10 * 60 },
      201,
    );
    const r = await h.json(`/api/entries/${free.id}`, {
      method: 'PATCH',
      json: { start_at: now - 5 * HOUR },
    });
    expect(r.body.error).toBe('locked_period');
  });
});

describe('rate-locked entries (§4.1)', () => {
  it('requires a decision when moving to another client/project', async () => {
    const a = await call(h, 'POST', '/api/clients', { name: 'A', hourly_rate: 100000 }, 201);
    const b = await call(h, 'POST', '/api/clients', { name: 'B', hourly_rate: 200000 }, 201);
    const e = await call(h, 'POST', '/api/entries', entry({ client_id: a.id }), 201);
    await db.run(
      'UPDATE time_entries SET rate_locked_at = 1, locked_rate = 100000, locked_currency = ? WHERE id = ?',
      'EUR',
      e.id,
    );

    // Editing time and description is fine.
    await call(h, 'PATCH', `/api/entries/${e.id}`, { description: 'still editable' }, 200);
    const r = await h.json(`/api/entries/${e.id}`, { method: 'PATCH', json: { client_id: b.id } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'rate_lock_decision', locked_rate: 100000 });

    const kept = await call(
      h,
      'PATCH',
      `/api/entries/${e.id}`,
      { client_id: b.id, rate_lock: 'keep' },
      200,
    );
    expect(kept).toMatchObject({ client_id: b.id, rate: 100000, rate_source: 'locked' });
    const released = await call(
      h,
      'PATCH',
      `/api/entries/${e.id}`,
      { client_id: a.id, rate_lock: 'release' },
      200,
    );
    expect(released).toMatchObject({
      client_id: a.id,
      rate: 100000,
      rate_source: 'client',
      rate_locked_at: null,
    });
  });
});
