// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { SESSION_RENEW_BELOW, SESSION_TTL } from '../src/modules/auth/session';
import { ORIGIN, db, harness, resetDb, type Harness } from './helpers';
import { SoftAuthenticator } from './soft-authenticator';

const TOKEN = 'test-setup-token-0123456789';
const newKey = () => new SoftAuthenticator('stoppeklokke.test', ORIGIN).init();

async function setup(h: Harness, key: SoftAuthenticator) {
  const opts = await h.json('/api/auth/register/options', {
    method: 'POST',
    json: { setup_token: TOKEN },
  });
  expect(opts.status).toBe(200);
  return h.json('/api/auth/register/verify', {
    method: 'POST',
    json: { setup_token: TOKEN, label: 'Laptop', response: await key.register(opts.body) },
  });
}

async function login(h: Harness, key: SoftAuthenticator) {
  const opts = await h.json('/api/auth/login/options', { method: 'POST' });
  return h.json('/api/auth/login/verify', {
    method: 'POST',
    json: { response: await key.assert(opts.body) },
  });
}

beforeEach(resetDb);

describe('first-time setup', () => {
  it('reports setup_required while no passkey exists', async () => {
    const { body } = await harness().json('/api/auth/status');
    expect(body).toEqual({ setup_required: true, authenticated: false, must_register: false });
  });

  it('rejects a missing or wrong setup token', async () => {
    const h = harness();
    expect((await h.json('/api/auth/register/options', { method: 'POST', json: {} })).status).toBe(
      403,
    );
    const r = await h.json('/api/auth/register/options', {
      method: 'POST',
      json: { setup_token: 'wrong-token-wrong-token' },
    });
    expect(r.body.error).toBe('bad_setup_token');
  });

  it('rate limits setup token guessing', async () => {
    const h = harness();
    const headers = { 'cf-connecting-ip': '203.0.113.9' };
    for (let i = 0; i < 10; i++) {
      const r = await h.json('/api/auth/register/options', {
        method: 'POST',
        headers,
        json: { setup_token: `guess-guess-guess-${i}` },
      });
      expect(r.body.error).toBe('bad_setup_token');
    }
    const blocked = await h.json('/api/auth/register/options', {
      method: 'POST',
      headers,
      json: { setup_token: TOKEN },
    });
    expect(blocked.status).toBe(429);
  });

  it('registers the first passkey, returns 10 recovery codes and logs in', async () => {
    const h = harness();
    const r = await setup(h, await newKey());
    expect(r.status).toBe(200);
    expect(r.body.recovery_codes).toHaveLength(10);
    expect(r.body.recovery_codes[0]).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    const stored = await db.all<{ code_hash: string }>('SELECT code_hash FROM recovery_codes');
    expect(stored).toHaveLength(10);
    expect(stored.map((s) => s.code_hash)).not.toContain(r.body.recovery_codes[0]);
    expect((await h.json('/api/auth/status')).body).toMatchObject({ authenticated: true });
  });

  it('is disabled once a passkey exists', async () => {
    await setup(harness(), await newKey());
    const r = await harness().json('/api/auth/register/options', {
      method: 'POST',
      json: { setup_token: TOKEN },
    });
    expect(r.body.error).toBe('setup_disabled');
  });

  it('rejects a registration from the wrong origin', async () => {
    const h = harness();
    const key = await newKey();
    const opts = await h.json('/api/auth/register/options', {
      method: 'POST',
      json: { setup_token: TOKEN },
    });
    const r = await h.json('/api/auth/register/verify', {
      method: 'POST',
      json: {
        setup_token: TOKEN,
        response: await key.register(opts.body, { origin: 'https://evil.example' }),
      },
    });
    expect(r.status).toBe(400);
    expect(await db.first('SELECT 1 FROM passkeys')).toBeNull();
  });
});

describe('login', () => {
  it('logs in with a registered passkey and updates the counter', async () => {
    const key = await newKey();
    await setup(harness(), key);
    const h = harness();
    expect((await login(h, key)).status).toBe(200);
    expect(h.cookie).toMatch(/^__Host-session=/);
    expect((await h.json('/api/auth/passkeys')).status).toBe(200);
    const pk = await db.first<{ counter: number; last_used_at: number }>(
      'SELECT counter, last_used_at FROM passkeys',
    );
    expect(pk?.counter).toBe(1);
    expect(pk?.last_used_at).toBe(h.clock.now());
  });

  it('sets a hardened session cookie', async () => {
    const key = await newKey();
    await setup(harness(), key);
    const h = harness();
    const opts = await h.json('/api/auth/login/options', { method: 'POST' });
    const res = await h.fetch('/api/auth/login/verify', {
      method: 'POST',
      json: { response: await key.assert(opts.body) },
    });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
  });

  it('rejects a replayed challenge', async () => {
    const key = await newKey();
    await setup(harness(), key);
    const h = harness();
    const opts = await h.json('/api/auth/login/options', { method: 'POST' });
    const response = await key.assert(opts.body);
    expect(
      (await h.json('/api/auth/login/verify', { method: 'POST', json: { response } })).status,
    ).toBe(200);
    const again = await harness().json('/api/auth/login/verify', {
      method: 'POST',
      json: { response },
    });
    expect(again.status).toBe(401);
  });

  it('rejects an expired challenge', async () => {
    const key = await newKey();
    await setup(harness(), key);
    const h = harness();
    const opts = await h.json('/api/auth/login/options', { method: 'POST' });
    h.clock.advance(301);
    const r = await h.json('/api/auth/login/verify', {
      method: 'POST',
      json: { response: await key.assert(opts.body) },
    });
    expect(r.status).toBe(401);
  });

  it('rejects an unknown passkey and missing user verification', async () => {
    await setup(harness(), await newKey());
    expect((await login(harness(), await newKey())).body.error).toBe('unknown_passkey');
  });

  it('rejects an assertion without user verification', async () => {
    const key = await newKey();
    await setup(harness(), key);
    const h = harness();
    const opts = await h.json('/api/auth/login/options', { method: 'POST' });
    const r = await h.json('/api/auth/login/verify', {
      method: 'POST',
      json: { response: await key.assert(opts.body, { uv: false }) },
    });
    expect(r.status).toBe(401);
    expect(h.cookie).toBeNull();
  });
});

describe('passkeys', () => {
  it('adds a second passkey with a session and refuses to delete the last one', async () => {
    const h = harness();
    await setup(h, await newKey());
    const second = await newKey();
    const opts = await h.json('/api/auth/register/options', { method: 'POST', json: {} });
    expect(opts.body.excludeCredentials).toHaveLength(1);
    const r = await h.json('/api/auth/register/verify', {
      method: 'POST',
      json: { label: 'Phone', response: await second.register(opts.body) },
    });
    expect(r.status).toBe(200);
    expect(r.body.recovery_codes).toBeUndefined();
    const list = (await h.json('/api/auth/passkeys')).body;
    expect(list.map((p: { label: string }) => p.label)).toEqual(['Laptop', 'Phone']);

    expect((await h.json(`/api/auth/passkeys/${list[0].id}`, { method: 'DELETE' })).status).toBe(
      200,
    );
    const last = await h.json(`/api/auth/passkeys/${list[1].id}`, { method: 'DELETE' });
    expect(last.status).toBe(409);
    expect((await h.json('/api/auth/passkeys/nope', { method: 'DELETE' })).status).toBe(404);
    // A login with the second passkey works.
    expect((await login(harness(), second)).status).toBe(200);
  });
});

describe('recovery codes', () => {
  it('allows one login that may only register a new passkey', async () => {
    const codes = (await setup(harness(), await newKey())).body.recovery_codes as string[];
    const h = harness();
    const r = await h.json('/api/auth/recovery', {
      method: 'POST',
      json: { code: codes[3]!.toLowerCase().replace(/-/g, ' ') },
    });
    expect(r.body).toEqual({ ok: true, must_register: true });
    expect((await h.json('/api/auth/status')).body.must_register).toBe(true);
    expect((await h.json('/api/auth/passkeys')).body.error).toBe('must_register');

    const fresh = await newKey();
    const opts = await h.json('/api/auth/register/options', { method: 'POST', json: {} });
    await h.json('/api/auth/register/verify', {
      method: 'POST',
      json: { response: await fresh.register(opts.body) },
    });
    expect((await h.json('/api/auth/passkeys')).status).toBe(200);

    // The code is single-use.
    const again = await harness().json('/api/auth/recovery', {
      method: 'POST',
      json: { code: codes[3] },
    });
    expect(again.status).toBe(401);
  });

  it('rate limits after 10 attempts in 10 minutes per IP', async () => {
    const h = harness();
    const headers = { 'cf-connecting-ip': '203.0.113.7' };
    for (let i = 0; i < 10; i++) {
      const r = await h.json('/api/auth/recovery', {
        method: 'POST',
        headers,
        json: { code: 'nope' },
      });
      expect(r.status).toBe(401);
    }
    const blocked = await h.json('/api/auth/recovery', {
      method: 'POST',
      headers,
      json: { code: 'nope' },
    });
    expect(blocked.status).toBe(429);
    // Another IP is unaffected; after the window the IP may try again.
    const other = await h.json('/api/auth/recovery', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '198.51.100.1' },
      json: { code: 'nope' },
    });
    expect(other.status).toBe(401);
    h.clock.advance(601);
    expect(
      (await h.json('/api/auth/recovery', { method: 'POST', headers, json: { code: 'nope' } }))
        .status,
    ).toBe(401);
  });
});

describe('sessions', () => {
  it('expires after 30 days and slides when under 15 days remain', async () => {
    const h = harness();
    await setup(h, await newKey());
    const first = h.cookie;
    h.clock.advance(SESSION_TTL - SESSION_RENEW_BELOW - 10);
    const fresh = await h.fetch('/api/auth/passkeys');
    expect(fresh.headers.get('set-cookie')).toBeNull();
    h.clock.advance(20);
    const renewed = await h.fetch('/api/auth/passkeys');
    expect(renewed.headers.get('set-cookie')).toContain('__Host-session=');
    expect(h.cookie).toBe(first); // same token, new expiry
    h.clock.advance(SESSION_TTL + 1);
    expect((await h.fetch('/api/auth/passkeys')).status).toBe(401);
  });

  it('logs out this device or all devices', async () => {
    const key = await newKey();
    await setup(harness(), key);
    const a = harness();
    const b = harness();
    await login(a, key);
    await login(b, key);
    await a.json('/api/auth/logout', { method: 'POST' });
    expect((await a.fetch('/api/auth/passkeys')).status).toBe(401);
    expect((await b.fetch('/api/auth/passkeys')).status).toBe(200);
    const c = harness();
    await login(c, key);
    await c.json('/api/auth/logout-all', { method: 'POST' });
    expect((await b.fetch('/api/auth/passkeys')).status).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const h = harness();
    await setup(h, await newKey());
    const token = h.cookie!.split('=')[1]!;
    const rows = await db.all<{ id_hash: string }>('SELECT id_hash FROM sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id_hash).not.toContain(token);
    expect(rows[0]!.id_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
