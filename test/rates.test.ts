// SPDX-License-Identifier: AGPL-3.0-or-later
// Rate inheritance through the API and the rate-change flow (§4, §4.2, §13).
import { beforeEach, describe, expect, it } from 'vitest';
import { HOUR, authed, call, resetDb, type Harness } from './helpers';

let h: Harness;
let ws: number;
let t: number;
beforeEach(async () => {
  await resetDb();
  h = await authed();
  t = h.clock.now() - 100 * HOUR;
  ws = (await call(h, 'POST', '/api/workspaces', { name: 'Work' }, 201)).id;
  await call(h, 'PATCH', '/api/settings', { currency: 'NOK' }, 200);
});

/** A completed 1 h entry; each call gets its own slot. */
async function add(refs: Record<string, unknown> = {}) {
  t += 2 * HOUR;
  return call(h, 'POST', '/api/entries', { start_at: t, end_at: t + HOUR, ...refs }, 201);
}
const rateOf = async (id: number) =>
  (await call(h, 'GET', '/api/entries', undefined, 200)).find((e: { id: number }) => e.id === id)
    .rate;

describe('rate inheritance (§13)', () => {
  it('general 1000, client 1200, project 1500', async () => {
    await call(h, 'PATCH', '/api/settings', { default_hourly_rate: 100000 }, 200);
    const c = await call(h, 'POST', '/api/clients', { name: 'Acme', hourly_rate: 120000 }, 201);
    const p = await call(
      h,
      'POST',
      '/api/projects',
      { client_id: c.id, name: 'Site', hourly_rate: 150000 },
      201,
    );
    const ep = await add({ project_id: p.id });
    const ec = await add({ client_id: c.id });
    const eu = await add();
    expect([ep.rate, ec.rate, eu.rate]).toEqual([150000, 120000, 100000]);
    expect(ep.currency).toBe('NOK');

    // Removing the project rate (update history) → 1200.
    await call(
      h,
      'PATCH',
      `/api/projects/${p.id}`,
      { hourly_rate: null, rate_change: { mode: 'update' } },
      200,
    );
    expect(await rateOf(ep.id)).toBe(120000);
  });

  it('no rate anywhere → null rate', async () => {
    expect((await add()).rate).toBeNull();
  });

  it('workspace level: global 900, workspace 1000; removing the workspace rate → 900', async () => {
    await call(h, 'PATCH', '/api/settings', { default_hourly_rate: 90000 }, 200);
    await call(h, 'PATCH', `/api/workspaces/${ws}`, { default_hourly_rate: 100000 }, 200);
    const e = await add();
    expect(e.rate).toBe(100000);
    await call(
      h,
      'PATCH',
      `/api/workspaces/${ws}`,
      { default_hourly_rate: null, rate_change: { mode: 'update' } },
      200,
    );
    expect(await rateOf(e.id)).toBe(90000);
  });
});

describe('rate change flow (§4.2)', () => {
  let client: { id: number };
  let project: { id: number };
  let old: { id: number };
  let own: { id: number };
  beforeEach(async () => {
    client = await call(h, 'POST', '/api/clients', { name: 'Acme', hourly_rate: 120000 }, 201);
    project = await call(
      h,
      'POST',
      '/api/projects',
      { client_id: client.id, name: 'Own rate', hourly_rate: 150000 },
      201,
    );
    old = await add({ client_id: client.id });
    own = await add({ project_id: project.id });
  });

  it('reports the impact', async () => {
    const impact = await call(
      h,
      'GET',
      `/api/rates/impact?level=client&id=${client.id}`,
      undefined,
      200,
    );
    expect(impact).toMatchObject({
      count: 1,
      seconds: HOUR,
      current_rate: 120000,
      currency: 'NOK',
    });
    const both = await call(
      h,
      'GET',
      `/api/rates/impact?level=client&id=${client.id}&change=both`,
      undefined,
      200,
    );
    expect(both.count).toBe(2);
  });

  it('rejects a PATCH without rate_change when on_rate_change=ask (409 with impact)', async () => {
    const r = await h.json(`/api/clients/${client.id}`, {
      method: 'PATCH',
      json: { hourly_rate: 140000 },
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'rate_change_required', impact: { count: 1 } });
    expect(await rateOf(old.id)).toBe(120000);
  });

  it('"lock" keeps old entries at 1200, new ones get 1400; own-rate project unaffected', async () => {
    const res = await call(
      h,
      'PATCH',
      `/api/clients/${client.id}`,
      { hourly_rate: 140000, rate_change: { mode: 'lock' } },
      200,
    );
    expect(res.rate_change_result).toMatchObject({ locked: 1 });
    const fresh = await add({ client_id: client.id });
    expect([await rateOf(old.id), fresh.rate, await rateOf(own.id)]).toEqual([
      120000, 140000, 150000,
    ]);
  });

  it('"update" rewrites unlocked history to 1400', async () => {
    await call(
      h,
      'PATCH',
      `/api/clients/${client.id}`,
      { hourly_rate: 140000, rate_change: { mode: 'update' } },
      200,
    );
    expect([await rateOf(old.id), await rateOf(own.id)]).toEqual([140000, 150000]);
  });

  it('"lock_before" only locks entries starting before the date', async () => {
    const later = await add({ client_id: client.id });
    await call(
      h,
      'PATCH',
      `/api/clients/${client.id}`,
      { hourly_rate: 140000, rate_change: { mode: 'lock_before', before: later.start_at } },
      200,
    );
    expect([await rateOf(old.id), await rateOf(later.id)]).toEqual([120000, 140000]);
  });

  it('follows on_rate_change=lock from the workspace without asking', async () => {
    await call(h, 'PATCH', `/api/workspaces/${ws}`, { on_rate_change: 'lock' }, 200);
    const res = await call(h, 'PATCH', `/api/clients/${client.id}`, { hourly_rate: 140000 }, 200);
    expect(res.rate_change_result.locked).toBe(1);
    expect(await rateOf(old.id)).toBe(120000);
  });

  it('never affects the running timer', async () => {
    const { entry } = await call(h, 'POST', '/api/timer/start', { client_id: client.id }, 200);
    await call(
      h,
      'PATCH',
      `/api/clients/${client.id}`,
      { hourly_rate: 140000, rate_change: { mode: 'lock' } },
      200,
    );
    expect((await call(h, 'GET', '/api/timer')).rate).toBe(140000);
    expect(entry.rate_locked_at).toBeNull();
  });

  it('locks when a level goes from inherit to its own value (NULL → X)', async () => {
    await call(
      h,
      'PATCH',
      '/api/settings',
      { default_hourly_rate: 100000, rate_change: { mode: 'update' } },
      200,
    );
    const plain = await add();
    expect(plain.rate).toBe(100000);
    const r = await h.json(`/api/workspaces/${ws}`, {
      method: 'PATCH',
      json: { default_hourly_rate: 110000 },
    });
    expect(r.body).toMatchObject({ error: 'rate_change_required', impact: { count: 1 } });
    await call(
      h,
      'PATCH',
      `/api/workspaces/${ws}`,
      { default_hourly_rate: 110000, rate_change: { mode: 'lock' } },
      200,
    );
    expect([await rateOf(plain.id), (await add()).rate]).toEqual([100000, 110000]);
  });

  it('locks on currency change too, keeping the old currency', async () => {
    await call(
      h,
      'PATCH',
      `/api/clients/${client.id}`,
      { currency: 'EUR', rate_change: { mode: 'lock' } },
      200,
    );
    const list = await call(h, 'GET', '/api/entries', undefined, 200);
    expect(list.find((e: { id: number }) => e.id === old.id)).toMatchObject({
      currency: 'NOK',
      rate_source: 'locked',
    });
    // The own-rate project inherits its currency from the client, so it is locked too.
    expect(list.find((e: { id: number }) => e.id === own.id)).toMatchObject({
      currency: 'NOK',
      rate: 150000,
      rate_source: 'locked',
    });
    expect((await add({ project_id: project.id })).currency).toBe('EUR');
  });
});
