// SPDX-License-Identifier: AGPL-3.0-or-later
// Reports, CSV, invoice basis and period locks through the API (§4.1, §9, §13).
import { beforeEach, describe, expect, it } from 'vitest';
import { zonedToEpoch } from '../src/core/time/tz';
import { HOUR, authed, call, db, resetDb, type Harness } from './helpers';

const TZ = 'Europe/Oslo';
const sep = (d: number, h: number, m = 0) => zonedToEpoch(2026, 9, d, h, m, TZ);

let h: Harness;
let ws: number;
let acme: { id: number };
let euro: { id: number };
let site: { id: number };

beforeEach(async () => {
  await resetDb();
  h = await authed();
  h.clock.t = zonedToEpoch(2026, 10, 7, 12, 0, TZ);
  await call(h, 'PATCH', '/api/settings', { timezone: TZ, currency: 'NOK', locale: 'en' }, 200);
  ws = (await call(h, 'POST', '/api/workspaces', { name: 'Self-employed' }, 201)).id;
  acme = await call(h, 'POST', '/api/clients', { name: 'Acme', hourly_rate: 120000 }, 201);
  euro = await call(
    h,
    'POST',
    '/api/clients',
    { name: 'Euro GmbH', hourly_rate: 10000, currency: 'EUR' },
    201,
  );
  site = await call(h, 'POST', '/api/projects', { client_id: acme.id, name: 'Website' }, 201);
});

const add = (
  start: number,
  end: number,
  refs: Record<string, unknown> = {},
  description = 'Work',
) => call(h, 'POST', '/api/entries', { start_at: start, end_at: end, description, ...refs }, 201);

describe('summary report', () => {
  it('groups last month by client with 15-min rounding and per-currency totals (§13)', async () => {
    await call(h, 'PATCH', '/api/settings', { rounding_min: 15, rounding_mode: 'nearest' }, 200);
    await add(sep(1, 9), sep(1, 9, 50), { project_id: site.id }); // 50 → 45
    await add(sep(2, 9), sep(2, 10, 10), { client_id: acme.id }); // 70 → 75
    await add(sep(3, 9), sep(3, 11), { client_id: euro.id });
    const r = await call(
      h,
      'GET',
      `/api/reports/summary?from=2026-09-01&to=2026-09-30&group_by=client`,
      undefined,
      200,
    );
    const byClient = Object.fromEntries(r.groups.map((g: any) => [g.id, g]));
    expect(byClient[acme.id]).toMatchObject({ seconds: 2 * HOUR, amounts: { NOK: 240000 } });
    expect(byClient[euro.id]).toMatchObject({ seconds: 2 * HOUR, amounts: { EUR: 20000 } });
    expect(r.totals.amounts).toEqual({ NOK: 240000, EUR: 20000 });
    expect(r.days).toHaveLength(30);
    expect(byClient[acme.id].days).toEqual({ '2026-09-01': 45 * 60, '2026-09-02': 75 * 60 });
  });

  it('hides amounts when no rate exists anywhere; non-billable counts hours only', async () => {
    const plain = await call(h, 'POST', '/api/clients', { name: 'Plain' }, 201);
    await add(sep(1, 9), sep(1, 10), { client_id: plain.id });
    const r = await call(
      h,
      'GET',
      `/api/reports/summary?from=2026-09-01&to=2026-09-30&client_id=${plain.id}`,
      undefined,
      200,
    );
    expect(r.has_amounts).toBe(false);
    const e = await add(sep(2, 9), sep(2, 10), { client_id: acme.id });
    await call(h, 'PATCH', `/api/entries/${e.id}`, { billable: false }, 200);
    const r2 = await call(
      h,
      'GET',
      `/api/reports/summary?from=2026-09-01&to=2026-09-30&client_id=${acme.id}`,
      undefined,
      200,
    );
    expect(r2.totals).toMatchObject({ seconds: HOUR, billable_seconds: 0, amounts: {} });
  });
});

describe('CSV export', () => {
  beforeEach(async () => {
    await add(sep(1, 9), sep(1, 10, 30), { project_id: site.id }, 'Design; "v2"');
    await add(sep(2, 9), sep(2, 10), { client_id: euro.id }, '=cmd');
  });

  it('en: comma separator, dot decimal, BOM, localized headers', async () => {
    const res = await h.fetch('/api/reports/export.csv?from=2026-09-01&to=2026-09-30');
    expect(res.headers.get('content-type')).toContain('text/csv');
    // Response.text() strips a BOM (Encoding spec), so check the raw bytes.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).trim().split('\r\n');
    expect(lines[0]).toBe(
      'Date,Start,End,Duration,Hours,Client,Project,Description,Billable,Rate,Currency,Amount,Locked,Lock note',
    );
    expect(lines[1]).toBe(
      '2026-09-01,09:00,10:30,1:30,1.50,Acme,Website,"Design; ""v2""",Yes,1200.00,NOK,1800.00,No,',
    );
    expect(lines[2]).toContain(",'=cmd,");
  });

  it('nb: semicolon separator, comma decimal, Norwegian headers', async () => {
    await call(h, 'PATCH', '/api/settings', { locale: 'nb' }, 200);
    const lines = (
      await (await h.fetch('/api/reports/export.csv?from=2026-09-01&to=2026-09-30')).text()
    )
      .trim()
      .split('\r\n');
    expect(lines[0]!.startsWith('Dato;Start;Slutt;Varighet;Timer;Kunde')).toBe(true);
    expect(lines[1]).toBe(
      '2026-09-01;09:00;10:30;1:30;1,50;Acme;Website;"Design; ""v2""";Ja;1200,00;NOK;1800,00;Nei;',
    );
  });

  it('supports machine keys and overrides, and adds a workspace column with >1 workspace', async () => {
    await call(h, 'POST', '/api/workspaces', { name: 'Board' }, 201);
    const text = await (
      await h.fetch(
        '/api/reports/export.csv?from=2026-09-01&to=2026-09-30&headers=keys&sep=;&decimal=,',
      )
    ).text();
    // workerd's text() strips the BOM, Bun's does not; compare without it.
    expect(text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(
      'date;start;end;duration;workspace;hours;client;project;description;billable;rate;currency;amount;locked;lock_note',
    );
  });
});

describe('period locks (§4.1, §13)', () => {
  let september: number;
  let e1: { id: number };
  beforeEach(async () => {
    e1 = await add(sep(10, 9), sep(10, 10), { project_id: site.id });
    await add(sep(11, 9), sep(11, 10, 7), { client_id: euro.id });
  });

  const lockSeptember = async (extra: Record<string, unknown> = {}) =>
    call(
      h,
      'POST',
      '/api/locks',
      {
        workspace_id: ws,
        from_date: '2026-09-01',
        to_date: '2026-09-30',
        note: 'INV-42',
        ...extra,
      },
      201,
    );

  it('previews the lock', async () => {
    const p = await call(
      h,
      'POST',
      '/api/locks/preview',
      { workspace_id: ws, from_date: '2026-09-01', to_date: '2026-09-30' },
      200,
    );
    expect(p).toMatchObject({
      count: 2,
      seconds: 2 * HOUR + 7 * 60,
      amounts: { NOK: 120000, EUR: 10000 + 1167 },
      already_locked: 0,
    });
  });

  it('freezes September: no edits, no new time, amounts stable after rate and rounding changes; unlock restores', async () => {
    const lock = await lockSeptember();
    september = lock.id;
    expect(lock).toMatchObject({ entries: 2, note: 'INV-42', timezone: TZ, rounding_min: 0 });

    expect(
      (await h.json(`/api/entries/${e1.id}`, { method: 'PATCH', json: { description: 'x' } }))
        .status,
    ).toBe(409);
    expect((await h.json(`/api/entries/${e1.id}`, { method: 'DELETE' })).status).toBe(409);
    expect(
      (
        await h.json('/api/entries', {
          method: 'POST',
          json: { start_at: sep(15, 9), end_at: sep(15, 10) },
        })
      ).body.error,
    ).toBe('locked_period');

    const before = await call(
      h,
      'GET',
      '/api/reports/summary?from=2026-09-01&to=2026-09-30',
      undefined,
      200,
    );
    await call(
      h,
      'PATCH',
      `/api/clients/${acme.id}`,
      { hourly_rate: 150000, rate_change: { mode: 'update' } },
      200,
    );
    await call(h, 'PATCH', '/api/settings', { rounding_min: 30, rounding_mode: 'up' }, 200);
    const after = await call(
      h,
      'GET',
      '/api/reports/summary?from=2026-09-01&to=2026-09-30',
      undefined,
      200,
    );
    expect(after.totals).toEqual(before.totals);

    // Changing the time zone never changes which entries are locked.
    await call(h, 'PATCH', '/api/settings', { timezone: 'America/New_York' }, 200);
    expect(
      (
        await db.first<{ n: number }>(
          'SELECT COUNT(*) AS n FROM time_entries WHERE period_lock_id = ?',
          september,
        )
      )?.n,
    ).toBe(2);
    const l = (await call(h, 'GET', '/api/locks', undefined, 200))[0];
    expect([l.from_at, l.to_at]).toEqual([lock.from_at, lock.to_at]);

    const del = await call(h, 'DELETE', `/api/locks/${september}`, undefined, 200);
    expect(del.released).toBe(2);
    await call(h, 'PATCH', `/api/entries/${e1.id}`, { description: 'editable again' }, 200);
    // Rate locks are kept by default.
    const row = await db.first<{ rate_locked_at: number | null; locked_rate: number }>(
      'SELECT rate_locked_at, locked_rate FROM time_entries WHERE id = ?',
      e1.id,
    );
    expect(row).toMatchObject({ locked_rate: 120000 });
    expect(row!.rate_locked_at).not.toBeNull();
  });

  it('can release rates when unlocking', async () => {
    const lock = await lockSeptember();
    await call(h, 'DELETE', `/api/locks/${lock.id}?release_rates=1`, undefined, 200);
    expect(
      (
        await db.first<{ n: number }>(
          'SELECT COUNT(*) AS n FROM time_entries WHERE rate_locked_at IS NOT NULL',
        )
      )?.n,
    ).toBe(0);
  });

  it('skips already locked entries and never locks the running timer', async () => {
    await lockSeptember({ client_id: euro.id });
    const p = await call(
      h,
      'POST',
      '/api/locks/preview',
      { workspace_id: ws, from_date: '2026-09-01', to_date: '2026-09-30' },
      200,
    );
    expect(p).toMatchObject({ count: 1, already_locked: 1 });
    await call(h, 'POST', '/api/timer/start', {}, 200);
    const oct = await call(
      h,
      'POST',
      '/api/locks',
      { workspace_id: ws, from_date: '2026-10-01', to_date: '2026-10-31' },
      201,
    );
    expect(oct.entries).toBe(0);
  });

  it('validates the scope', async () => {
    const other = (await call(h, 'POST', '/api/workspaces', { name: 'Other' }, 201)).id;
    const bad = await h.json('/api/locks', {
      method: 'POST',
      json: {
        workspace_id: other,
        client_id: acme.id,
        from_date: '2026-09-01',
        to_date: '2026-09-30',
      },
    });
    expect(bad.body.error).toBe('workspace_conflict');
    const reversed = await h.json('/api/locks', {
      method: 'POST',
      json: { workspace_id: ws, from_date: '2026-09-30', to_date: '2026-09-01' },
    });
    expect(reversed.status).toBe(400);
  });
});

describe('invoice basis (§9.2, §13)', () => {
  it('matches the summary, and is empty for unlocked-only after locking', async () => {
    await add(sep(1, 9), sep(1, 11), { project_id: site.id }, 'Design');
    await add(sep(2, 9), sep(2, 10), { project_id: site.id }, 'Design');
    await add(sep(3, 9), sep(3, 10), { client_id: acme.id }, 'Support');
    const nb = await add(sep(4, 9), sep(4, 10), { client_id: acme.id }, 'Internal');
    await call(h, 'PATCH', `/api/entries/${nb.id}`, { billable: false }, 200);

    const q = `workspace_id=${ws}&client_id=${acme.id}&from=2026-09-01&to=2026-09-30`;
    const basis = await call(h, 'GET', `/api/reports/invoice?${q}`, undefined, 200);
    expect(basis.projects).toHaveLength(2);
    const design = basis.projects.find((p: any) => p.project_id === site.id);
    expect(design.lines).toMatchObject([
      { description: 'Design', seconds: 3 * HOUR, rate: 120000, amount: 360000 },
    ]);
    expect(basis.non_billable).toMatchObject([{ description: 'Internal', seconds: HOUR }]);
    const summary = await call(
      h,
      'GET',
      `/api/reports/summary?from=2026-09-01&to=2026-09-30&client_id=${acme.id}`,
      undefined,
      200,
    );
    expect(basis.totals.amounts).toEqual(summary.totals.amounts);

    const csv = await (await h.fetch(`/api/reports/invoice.csv?${q}&headers=keys`)).text();
    expect(csv.split('\r\n')[1]).toBe('Website,Design,3.00,1200.00,NOK,3600.00,yes');

    await call(
      h,
      'POST',
      '/api/locks',
      {
        workspace_id: ws,
        client_id: acme.id,
        from_date: '2026-09-01',
        to_date: '2026-09-30',
        note: 'INV-1',
      },
      201,
    );
    const after = await call(h, 'GET', `/api/reports/invoice?${q}`, undefined, 200);
    expect(after.projects).toEqual([]);
    expect(after.non_billable).toEqual([]);
  });
});

describe('manual rate locks', () => {
  it('locks and releases selected entries; undo within 5 minutes', async () => {
    const a = await add(sep(1, 9), sep(1, 10), { client_id: acme.id });
    const b = await add(sep(2, 9), sep(2, 10), { client_id: acme.id });
    const r = await call(h, 'POST', '/api/entries/rate-lock', { ids: [a.id, b.id] }, 200);
    expect(r.locked).toBe(2);
    await call(
      h,
      'PATCH',
      `/api/clients/${acme.id}`,
      { hourly_rate: 200000, rate_change: { mode: 'update' } },
      200,
    );
    const list = await call(h, 'GET', '/api/entries', undefined, 200);
    expect(list.map((e: any) => e.rate)).toEqual([120000, 120000]);

    expect((await call(h, 'POST', '/api/entries/rate-unlock', { ids: [a.id] }, 200)).released).toBe(
      1,
    );
    h.clock.advance(301);
    expect(
      (
        await h.json('/api/entries/rate-unlock', {
          method: 'POST',
          json: { locked_at: r.locked_at },
        })
      ).body.error,
    ).toBe('undo_expired');
    h.clock.advance(-301);
    expect(
      (await call(h, 'POST', '/api/entries/rate-unlock', { locked_at: r.locked_at }, 200)).released,
    ).toBe(1);
  });

  it('never releases rate locks on period-locked entries', async () => {
    const a = await add(sep(1, 9), sep(1, 10), { client_id: acme.id });
    await call(
      h,
      'POST',
      '/api/locks',
      { workspace_id: ws, from_date: '2026-09-01', to_date: '2026-09-30' },
      201,
    );
    const r = await call(h, 'POST', '/api/entries/rate-unlock', { ids: [a.id] }, 200);
    expect(r).toEqual({ released: 0, skipped_period_locked: 1 });
  });

  it('locks a date range', async () => {
    await add(sep(1, 9), sep(1, 10), { client_id: acme.id });
    await add(sep(20, 9), sep(20, 10), { client_id: acme.id });
    const r = await call(
      h,
      'POST',
      '/api/entries/rate-lock',
      { from: '2026-09-01', to: '2026-09-10' },
      200,
    );
    expect(r.locked).toBe(1);
  });
});
