// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { resolveRate } from '../src/core/rates/resolve';
import { DEFAULT_SETTINGS, settingsFromRows, suggestCurrency } from '../src/core/settings/defs';
import { resolveSetting } from '../src/core/settings/resolve';

const settings = { ...DEFAULT_SETTINGS, default_hourly_rate: 90000, currency: 'NOK' };
const r = (hourly_rate: number | null, currency: string | null = null) => ({
  hourly_rate,
  currency,
});
const ws = (default_hourly_rate: number | null, currency: string | null = null) => ({
  default_hourly_rate,
  currency,
});
const unlocked = { rate_locked_at: null, locked_rate: null, locked_currency: null };

describe('resolveRate', () => {
  // Every combination of project/client/workspace/global rate being set or not.
  const levels = ['project', 'client', 'workspace', 'default'] as const;
  for (let mask = 0; mask < 16; mask++) {
    const has = levels.map((_, i) => (mask & (1 << i)) !== 0);
    const label = levels.filter((_, i) => has[i]).join('+') || 'none';
    it(`picks the most specific rate (${label})`, () => {
      const res = resolveRate(
        unlocked,
        r(has[0] ? 150000 : null),
        r(has[1] ? 120000 : null),
        ws(has[2] ? 100000 : null),
        { ...settings, default_hourly_rate: has[3] ? 90000 : null },
      );
      const first = has.indexOf(true);
      expect(res.source).toBe(first === -1 ? null : levels[first]);
      expect(res.rate).toBe([150000, 120000, 100000, 90000][first] ?? null);
    });
  }

  it('acceptance §13: 900 / 1000 / 1200 / 1500 chain', () => {
    const W = ws(100000);
    expect(resolveRate(unlocked, r(150000), r(120000), W, settings).rate).toBe(150000);
    expect(resolveRate(unlocked, null, r(120000), W, settings).rate).toBe(120000);
    expect(resolveRate(unlocked, null, null, W, settings).rate).toBe(100000);
    expect(resolveRate(unlocked, null, null, ws(null), settings).rate).toBe(90000);
  });

  it('treats 0 as an explicit rate (pro bono), not as inherit', () => {
    const res = resolveRate(unlocked, r(0), r(120000), ws(null), settings);
    expect(res).toEqual({ rate: 0, currency: 'NOK', source: 'project' });
  });

  it('inherits currency independently of the rate', () => {
    const res = resolveRate(unlocked, r(150000), r(null, 'EUR'), ws(null), settings);
    expect(res).toEqual({ rate: 150000, currency: 'EUR', source: 'project' });
    expect(resolveRate(unlocked, null, null, ws(null, 'SEK'), settings).currency).toBe('SEK');
  });

  it('checks the rate lock first, including a locked "no rate"', () => {
    const locked = { rate_locked_at: 1, locked_rate: 110000, locked_currency: 'NOK' };
    expect(resolveRate(locked, r(150000, 'EUR'), null, null, settings)).toEqual({
      rate: 110000,
      currency: 'NOK',
      source: 'locked',
    });
    const lockedNone = { rate_locked_at: 1, locked_rate: null, locked_currency: 'NOK' };
    expect(resolveRate(lockedNone, r(150000), null, null, settings)).toEqual({
      rate: null,
      currency: 'NOK',
      source: 'locked',
    });
  });
});

describe('resolveSetting', () => {
  const W = {
    currency: null,
    default_hourly_rate: null,
    billable_default: 0,
    rounding_min: 15,
    rounding_mode: null,
    daily_target_min: null,
    alert_after_min: 120,
    tick_interval_min: null,
    on_rate_change: null,
  };

  it('uses project → workspace → global → default', () => {
    expect(resolveSetting('billable_default', { workspace: W, settings })).toBe(false);
    expect(
      resolveSetting('billable_default', {
        project: { billable_default: 1, alert_after_min: null, tick_interval_min: null },
        workspace: W,
        settings,
      }),
    ).toBe(true);
    expect(resolveSetting('rounding_min', { workspace: W, settings })).toBe(15);
    expect(resolveSetting('rounding_mode', { workspace: W, settings })).toBe('nearest');
    expect(resolveSetting('alert_after_min', { workspace: W, settings })).toBe(120);
    expect(
      resolveSetting('tick_interval_min', {
        project: { billable_default: null, alert_after_min: null, tick_interval_min: 0 },
        workspace: W,
        settings,
      }),
    ).toBe(0);
  });

  it('ignores project values for keys without project overrides', () => {
    expect(
      resolveSetting('rounding_min', { project: { rounding_min: 30 } as never, settings }),
    ).toBe(0);
  });
});

describe('settings defaults', () => {
  it('merges stored JSON values over defaults and ignores invalid ones', () => {
    const s = settingsFromRows([
      { key: 'timezone', value: '"Europe/Oslo"' },
      { key: 'rounding_min', value: '7' },
      { key: 'unknown', value: '1' },
      { key: 'locale', value: 'not json' },
    ]);
    expect(s.timezone).toBe('Europe/Oslo');
    expect(s.rounding_min).toBe(0);
    expect(s.locale).toBe('en');
    expect(s.clock_format).toBe('24h');
  });

  it('suggests NOK for Norwegian, otherwise EUR', () => {
    expect(suggestCurrency('nb')).toBe('NOK');
    expect(suggestCurrency('en')).toBe('EUR');
  });
});
