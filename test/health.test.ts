// SPDX-License-Identifier: AGPL-3.0-or-later
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { harness } from './helpers';

describe('GET /api/health', () => {
  it('reports version, sha and no config errors', async () => {
    const h = harness();
    const { status, body } = await h.json('/api/health');
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', version: '9.9.9', git_sha: 'testsha', config_errors: [] });
  });

  it('sets security headers and no-store', async () => {
    const res = await harness().fetch('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is served by the real worker entry point', async () => {
    const res = await SELF.fetch('https://stoppeklokke.test/api/health');
    expect(res.status).toBe(200);
  });

  it('serves static assets for non-API paths', async () => {
    const res = await SELF.fetch('https://stoppeklokke.test/');
    expect(await res.text()).toContain('fixture');
  });
});

describe('auth guard', () => {
  it('rejects unauthenticated API calls with 401', async () => {
    const { status } = await harness().json('/api/nope');
    expect(status).toBe(401);
  });

  it('rejects cross-origin state-changing requests with 403', async () => {
    const { status } = await harness().json('/api/health', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(status).toBe(403);
  });
});
