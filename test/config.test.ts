// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config';

describe('parseConfig', () => {
  const base = { ORIGIN: 'https://t.example.com', RP_ID: 't.example.com' };

  it('accepts a minimal config with defaults', () => {
    const { config, errors } = parseConfig(base);
    expect(errors).toEqual([]);
    expect(config.RP_NAME).toBe('Stoppeklokke');
    expect(config.SOURCE_URL).toBe('https://github.com/olemd/stoppeklokke');
  });

  it('reports a missing ORIGIN without throwing', () => {
    const { errors, config } = parseConfig({ RP_ID: 'x' });
    expect(errors.some((e) => e.startsWith('ORIGIN'))).toBe(true);
    expect(config.RP_ID).toBe('x');
  });

  it('rejects an ORIGIN with a path or trailing slash', () => {
    expect(parseConfig({ ...base, ORIGIN: 'https://t.example.com/' }).errors).toHaveLength(1);
  });

  it('requires RP_ID to match the origin host', () => {
    expect(parseConfig({ ...base, RP_ID: 'other.com' }).errors[0]).toContain('RP_ID');
    expect(parseConfig({ ...base, RP_ID: 'example.com' }).errors).toEqual([]);
  });

  it('requires VAPID keys together', () => {
    expect(parseConfig({ ...base, VAPID_PUBLIC_KEY: 'x' }).errors[0]).toContain('VAPID');
  });

  it('treats empty strings as unset', () => {
    expect(parseConfig({ ...base, SOURCE_URL: '' }).errors).toEqual([]);
  });
});
