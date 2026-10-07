// SPDX-License-Identifier: AGPL-3.0-or-later
// API tokens, webhooks and the OpenAPI document (§15.3).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex } from '../src/core/crypto';
import { HOUR, authed, call, harness, resetDb, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => {
  await resetDb();
  h = await authed();
  await call(h, 'POST', '/api/workspaces', { name: 'Work' }, 201);
});
afterEach(() => vi.restoreAllMocks());

/** A client with no cookie and no Origin header, like a script. */
function bearer(token: string) {
  const b = harness({ now: h.clock.now() });
  return (path: string, init: RequestInit & { json?: unknown } = {}) =>
    b.json(path, { ...init, headers: { authorization: `Bearer ${token}`, origin: '' } });
}

describe('API tokens', () => {
  it('creates a token shown once; read scope can read but not write', async () => {
    const t = await call(h, 'POST', '/api/tokens', { name: 'Home Assistant', scope: 'read' }, 201);
    expect(t.token).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    const list = await call(h, 'GET', '/api/tokens', undefined, 200);
    expect(list[0]).not.toHaveProperty('token');
    expect(list[0].prefix).toBe(t.token.slice(0, 10));

    const api = bearer(t.token);
    expect((await api('/api/timer')).status).toBe(200);
    expect((await api('/api/timer/start', { method: 'POST', json: {} })).status).toBe(403);
  });

  it('write scope can start a timer without an Origin header (no ambient credentials)', async () => {
    const t = await call(h, 'POST', '/api/tokens', { name: 'Stream Deck', scope: 'write' }, 201);
    const r = await bearer(t.token)('/api/timer/start', {
      method: 'POST',
      json: { description: 'from deck' },
    });
    expect(r.status).toBe(200);
    expect(r.body.entry.description).toBe('from deck');
  });

  it('rejects invalid, expired and revoked tokens', async () => {
    expect((await bearer('sk_nope')('/api/timer')).status).toBe(401);
    const exp = await call(
      h,
      'POST',
      '/api/tokens',
      { name: 'Short', expires_at: h.clock.now() + 60 },
      201,
    );
    const later = harness({ now: h.clock.now() + 61 });
    expect(
      (await later.json('/api/timer', { headers: { authorization: `Bearer ${exp.token}` } }))
        .status,
    ).toBe(401);
    const t = await call(h, 'POST', '/api/tokens', { name: 'Gone' }, 201);
    await call(h, 'DELETE', `/api/tokens/${t.id}`, undefined, 200);
    expect((await bearer(t.token)('/api/timer')).status).toBe(401);
  });

  it('cannot manage tokens, webhooks or passkeys (session only)', async () => {
    const t = await call(h, 'POST', '/api/tokens', { name: 'Script', scope: 'write' }, 201);
    const api = bearer(t.token);
    for (const [method, path] of [
      ['POST', '/api/tokens'],
      ['GET', '/api/tokens'],
      ['GET', '/api/webhooks'],
      ['GET', '/api/auth/passkeys'],
      ['POST', '/api/auth/logout-all'],
      ['POST', '/api/auth/register/options'],
    ] as const) {
      const r = await api(path, { method, json: method === 'POST' ? { name: 'x' } : undefined });
      expect([path, r.status]).toEqual([path, 403]);
    }
  });
});

describe('webhooks', () => {
  it('delivers subscribed events with a valid HMAC signature', async () => {
    const calls: { url: string; headers: Headers; body: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response('ok', { status: 200 });
    });
    const hook = await call(
      h,
      'POST',
      '/api/webhooks',
      { url: 'https://hooks.example.com/in', events: ['timer.started'] },
      201,
    );
    expect(hook.secret).toMatch(/^whsec_/);
    expect((await call(h, 'GET', '/api/webhooks'))[0]).not.toHaveProperty('secret');

    await call(h, 'POST', '/api/timer/start', { description: 'hooked' }, 200);
    await h.settle();
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://hooks.example.com/in');
    expect(c.headers.get('x-stoppeklokke-event')).toBe('timer.started');
    const ts = c.headers.get('x-stoppeklokke-timestamp')!;
    expect(c.headers.get('x-stoppeklokke-signature')).toBe(
      `sha256=${await hmacSha256Hex(hook.secret, `${ts}.${c.body}`)}`,
    );
    expect(JSON.parse(c.body)).toMatchObject({
      event: 'timer.started',
      data: { entry: { description: 'hooked' } },
    });

    // Unsubscribed events are not delivered.
    h.clock.advance(HOUR);
    await call(h, 'POST', '/api/timer/stop', {}, 200);
    await h.settle();
    expect(calls).toHaveLength(1);
  });

  it('records failures without retrying, and supports a test ping', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const hook = await call(
      h,
      'POST',
      '/api/webhooks',
      { url: 'https://hooks.example.com/in', events: ['entry.created'] },
      201,
    );
    expect(await call(h, 'POST', `/api/webhooks/${hook.id}/test`, undefined, 200)).toEqual({
      status: 500,
    });
    const listed = (await call(h, 'GET', '/api/webhooks'))[0];
    expect(listed).toMatchObject({ last_status: 500, last_error: 'HTTP 500' });
  });

  it('only accepts https URLs and known events', async () => {
    expect(
      (
        await h.json('/api/webhooks', {
          method: 'POST',
          json: { url: 'http://x.example/a', events: ['timer.started'] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.json('/api/webhooks', {
          method: 'POST',
          json: { url: 'https://x.example/a', events: ['nope'] },
        })
      ).status,
    ).toBe(400);
  });
});

describe('OpenAPI', () => {
  it('serves a public OpenAPI 3.1 document built from the route schemas', async () => {
    const r = await harness().json('/api/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe('3.1.0');
    expect(Object.keys(r.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/timer/start',
        '/api/entries/{id}',
        '/api/reports/summary',
        '/api/locks',
        '/api/tokens',
      ]),
    );
    expect(r.body.components.securitySchemes).toHaveProperty('token');
  });
});
