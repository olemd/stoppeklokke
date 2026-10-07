// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloudflare-only: the real Worker entry point with Workers Static Assets.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Worker entry point', () => {
  it('serves the API', async () => {
    const res = await SELF.fetch('https://stoppeklokke.test/api/health');
    expect(res.status).toBe(200);
  });

  it('returns 404 (not the SPA page) for missing hashed assets', async () => {
    const res = await SELF.fetch('https://stoppeklokke.test/assets/missing-0123.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves static assets for non-API paths', async () => {
    const res = await SELF.fetch('https://stoppeklokke.test/');
    expect(await res.text()).toContain('fixture');
  });
});
