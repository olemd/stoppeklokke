// SPDX-License-Identifier: AGPL-3.0-or-later
// Full export → import into a fresh instance gives identical reports (§9.1, §13).
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { zonedToEpoch } from '../src/core/time/tz';
import { HOUR, authed, call, db, resetDb, type Harness } from './helpers';

const TZ = 'Europe/Oslo';
let h: Harness;

/** Page through every collection exactly like the browser does. */
async function exportAll(x: Harness) {
  const meta = await call(x, 'GET', '/api/export', undefined, 200);
  const data: Record<string, unknown[]> = {};
  let requests = 0;
  for (const name of meta.collections as string[]) {
    data[name] = [];
    let cursor: string | null = null;
    do {
      const q: string = `/api/export?collection=${name}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await call(x, 'GET', q, undefined, 200);
      requests++;
      data[name]!.push(...page.rows);
      cursor = page.next;
    } while (cursor);
  }
  return {
    doc: {
      format: meta.format,
      version: meta.version,
      exported_at: 0,
      app_version: meta.app_version,
      data,
    },
    requests,
  };
}

async function importAll(x: Harness, doc: { data: Record<string, unknown[]> }) {
  await call(x, 'POST', '/api/import/begin', undefined, 200);
  const counts: Record<string, number> = {};
  for (const [collection, rows] of Object.entries(doc.data)) {
    counts[collection] = rows.length;
    for (let i = 0; i < rows.length; i += 500) {
      await call(x, 'POST', '/api/import', { collection, rows: rows.slice(i, i + 500) }, 200);
    }
  }
  return call(x, 'POST', '/api/import/finish', { counts }, 200);
}

async function snapshot(x: Harness) {
  return {
    summary: await call(
      x,
      'GET',
      '/api/reports/summary?from=2026-01-01&to=2026-12-31&group_by=client',
      undefined,
      200,
    ),
    days: await call(
      x,
      'GET',
      '/api/reports/summary?from=2026-09-01&to=2026-09-30&group_by=day',
      undefined,
      200,
    ),
    locks: await call(x, 'GET', '/api/locks', undefined, 200),
    entries: (await call(x, 'GET', '/api/entries?limit=2000', undefined, 200)).length,
  };
}

beforeEach(async () => {
  await resetDb();
  h = await authed();
  h.clock.t = zonedToEpoch(2026, 10, 7, 12, 0, TZ);
  await call(h, 'PATCH', '/api/settings', { timezone: TZ, currency: 'NOK', rounding_min: 15 }, 200);
  const ws = (
    await call(
      h,
      'POST',
      '/api/workspaces',
      { name: 'Self-employed', default_hourly_rate: 100000 },
      201,
    )
  ).id;
  const acme = await call(h, 'POST', '/api/clients', { name: 'Acme', hourly_rate: 120000 }, 201);
  const euro = await call(
    h,
    'POST',
    '/api/clients',
    { name: 'Euro', hourly_rate: 9000, currency: 'EUR' },
    201,
  );
  const p = await call(h, 'POST', '/api/projects', { client_id: acme.id, name: 'Website' }, 201);
  // 1200 entries (needs paging) inserted directly for speed.
  const start = zonedToEpoch(2026, 1, 5, 8, 0, TZ);
  const stmts = [];
  for (let i = 0; i < 1200; i++) {
    const s = start + i * 5 * HOUR;
    const refs = i % 3 === 0 ? [acme.id, p.id] : i % 3 === 1 ? [euro.id, null] : [null, null];
    stmts.push(
      env.DB.prepare(
        `INSERT INTO time_entries (workspace_id, client_id, project_id, description, start_at, end_at, billable, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        ws,
        refs[0],
        refs[1],
        `Task ${i % 17}`,
        s,
        s + 3000 + (i % 7) * 600,
        i % 5 === 0 ? 0 : 1,
        s,
        s,
      ),
    );
  }
  await env.DB.batch(stmts);
  await call(
    h,
    'POST',
    '/api/locks',
    { workspace_id: ws, from_date: '2026-09-01', to_date: '2026-09-30', note: 'INV-9' },
    201,
  );
  await call(
    h,
    'PATCH',
    `/api/clients/${acme.id}`,
    { hourly_rate: 140000, rate_change: { mode: 'lock' } },
    200,
  );
});

describe('export/import round trip (§13)', () => {
  it('reproduces identical reports, including locks, in a fresh instance', async () => {
    const before = await snapshot(h);
    const { doc, requests } = await exportAll(h);
    expect(doc.data.time_entries).toHaveLength(1200);
    expect(requests).toBeGreaterThan(6); // time_entries needed several pages
    expect(Object.keys(doc.data)).toEqual([
      'settings',
      'workspaces',
      'clients',
      'projects',
      'period_locks',
      'time_entries',
    ]);
    // Nothing secret leaves the instance.
    const json = JSON.stringify(doc);
    for (const secret of [
      'webauthn_user_id',
      'id_hash',
      'code_hash',
      'p256dh',
      'token_hash',
      'whsec_',
    ]) {
      expect(json).not.toContain(secret);
    }

    // A fresh instance: passkey set up, wizard created an empty workspace.
    await resetDb();
    const fresh = await authed({ now: h.clock.now() });
    await call(fresh, 'POST', '/api/workspaces', { name: 'Work' }, 201);
    const done = await importAll(fresh, doc);
    expect(done.counts.time_entries).toBe(1200);

    const after = await snapshot(fresh);
    expect(after).toEqual(before);
  });

  it('refuses to import into an instance with data, and without begin', async () => {
    expect((await h.json('/api/import/begin', { method: 'POST' })).body.error).toBe('not_empty');
    expect(
      (await h.json('/api/import', { method: 'POST', json: { collection: 'clients', rows: [] } }))
        .body.error,
    ).toBe('no_import');
    expect((await h.json('/api/import/wipe', { method: 'POST' })).body.error).toBe('no_import');
  });

  it('detects a count mismatch and can wipe a failed import to retry', async () => {
    const { doc } = await exportAll(h);
    await resetDb();
    const fresh = await authed();
    await call(fresh, 'POST', '/api/import/begin', undefined, 200);
    await call(
      fresh,
      'POST',
      '/api/import',
      { collection: 'workspaces', rows: doc.data.workspaces },
      200,
    );
    const r = await fresh.json('/api/import/finish', {
      method: 'POST',
      json: { counts: { workspaces: 1, clients: 2 } },
    });
    expect(r.body.error).toBe('count_mismatch');
    await call(fresh, 'POST', '/api/import/wipe', undefined, 200);
    expect((await db.all('SELECT name FROM workspaces')).map((w: any) => w.name)).toEqual(['Work']);
    const again = await importAll(fresh, doc);
    expect(again.counts.time_entries).toBe(1200);
  });

  it('rejects malformed rows atomically', async () => {
    await resetDb();
    const fresh = await authed();
    await call(fresh, 'POST', '/api/import/begin', undefined, 200);
    const r = await fresh.json('/api/import', {
      method: 'POST',
      json: { collection: 'workspaces', rows: [{ id: 1, name: 'A' }] },
    });
    expect(r.body.error).toBe('invalid_row');
    expect(await db.all('SELECT * FROM workspaces')).toEqual([]);
  });
});
