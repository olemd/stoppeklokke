// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { HOUR, authed, call, resetDb, type Harness } from './helpers';

let h: Harness;
let t: number;
beforeEach(async () => {
  await resetDb();
  h = await authed();
  t = h.clock.now() - 50 * HOUR;
  await call(h, 'POST', '/api/workspaces', { name: 'Work' }, 201);
});

async function add(description: string, refs: Record<string, unknown> = {}, at?: number) {
  t += 2 * HOUR;
  const start = at ?? t;
  return call(
    h,
    'POST',
    '/api/entries',
    { description, start_at: start, end_at: start + 600, ...refs },
    201,
  );
}

describe('description suggestions (§7.1)', () => {
  it('ranks prefix before substring, case-insensitive, with last-used project', async () => {
    const p = await call(h, 'POST', '/api/projects', { name: 'Site' }, 201);
    await add('Code review');
    await add('Review PR', { project_id: p.id });
    const r = await call(h, 'GET', '/api/suggestions/descriptions?q=rev', undefined, 200);
    expect(r.map((s: { description: string }) => s.description)).toEqual([
      'Review PR',
      'Code review',
    ]);
    expect(r[0].project_id).toBe(p.id);
  });

  it('puts the selected project first and ignores entries older than 90 days', async () => {
    const p = await call(h, 'POST', '/api/projects', { name: 'Site' }, 201);
    for (let i = 0; i < 3; i++) await add('Meeting');
    await add('Meeting notes', { project_id: p.id });
    await add('Ancient', {}, h.clock.now() - 91 * 86400);
    const r = await call(
      h,
      'GET',
      `/api/suggestions/descriptions?q=mee&project_id=${p.id}`,
      undefined,
      200,
    );
    expect(r.map((s: { description: string }) => s.description)).toEqual([
      'Meeting notes',
      'Meeting',
    ]);
    expect(await call(h, 'GET', '/api/suggestions/descriptions?q=anc', undefined, 200)).toEqual([]);
  });

  it('treats LIKE wildcards literally and caps results at 10', async () => {
    for (let i = 0; i < 12; i++) await add(`Task ${i}`);
    expect(await call(h, 'GET', '/api/suggestions/descriptions?q=%25', undefined, 200)).toEqual([]);
    expect(
      await call(h, 'GET', '/api/suggestions/descriptions?q=task', undefined, 200),
    ).toHaveLength(10);
  });
});
