// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { EntryRow } from '../src/core/model';
import type { RateLookup } from '../src/core/rates/resolve';
import { aggregate, invoiceBasis, priceEntries } from '../src/core/reports/aggregate';
import { csvCell, csvFormatFor, minorToDecimal } from '../src/core/reports/csv';
import { DEFAULT_SETTINGS } from '../src/core/settings/defs';
import { zonedToEpoch } from '../src/core/time/tz';

const TZ = 'Europe/Oslo';
const lookup = (over: Partial<RateLookup['settings']> = {}): RateLookup => ({
  workspaces: new Map([[1, { id: 1, default_hourly_rate: null, currency: null } as never]]),
  clients: new Map(),
  projects: new Map(),
  settings: {
    ...DEFAULT_SETTINGS,
    timezone: TZ,
    currency: 'NOK',
    default_hourly_rate: 100000,
    ...over,
  },
});
let nextId = 1;
const entry = (start: number, end: number, extra: Partial<EntryRow> = {}): EntryRow => ({
  id: nextId++,
  workspace_id: 1,
  client_id: null,
  project_id: null,
  description: 'x',
  start_at: start,
  end_at: end,
  billable: 1,
  rate_locked_at: null,
  locked_rate: null,
  locked_currency: null,
  period_lock_id: null,
  created_at: 0,
  updated_at: 0,
  ...extra,
});
const at = (d: number, h: number, m = 0) => zonedToEpoch(2026, 9, d, h, m, TZ);

describe('aggregate', () => {
  it('rounds per entry before summing and prices only billable time', () => {
    const priced = priceEntries(
      [
        entry(at(1, 9), at(1, 9, 8)),
        entry(at(1, 10), at(1, 10, 8)),
        entry(at(1, 11), at(1, 12), { billable: 0 }),
      ],
      lookup({ rounding_min: 15, rounding_mode: 'up' }),
      new Map(),
    );
    const r = aggregate(priced, 'project', { from: '2026-09-01', to: '2026-09-30', tz: TZ });
    expect(r.totals.seconds).toBe(15 * 60 * 2 + 3600);
    expect(r.totals.billable_seconds).toBe(30 * 60);
    expect(r.totals.amounts).toEqual({ NOK: 50000 });
    expect(r.has_amounts).toBe(true);
  });

  it('splits an entry crossing midnight proportionally in day grouping (§13)', () => {
    const priced = priceEntries([entry(at(10, 22), at(11, 2, 30))], lookup(), new Map());
    const r = aggregate(priced, 'day', { from: '2026-09-01', to: '2026-09-30', tz: TZ });
    expect(r.groups.map((g) => [g.key, g.seconds])).toEqual([
      ['2026-09-10', 2 * 3600],
      ['2026-09-11', 2.5 * 3600],
    ]);
    expect(r.groups.reduce((a, g) => a + (g.amounts.NOK ?? 0), 0)).toBe(r.totals.amounts.NOK);
    expect(r.days.find((d) => d.date === '2026-09-11')?.seconds).toBe(2.5 * 3600);
  });

  it('keeps the part after midnight of the last day on its real date', () => {
    const priced = priceEntries(
      [entry(at(30, 23), zonedToEpoch(2026, 10, 1, 1, 0, TZ))],
      lookup(),
      new Map(),
    );
    const r = aggregate(priced, 'day', { from: '2026-09-01', to: '2026-09-30', tz: TZ });
    expect(r.groups.map((g) => [g.key, g.seconds])).toEqual([
      ['2026-09-30', 3600],
      ['2026-10-01', 3600],
    ]);
  });

  it('groups by ISO week and month', () => {
    const priced = priceEntries(
      [entry(at(6, 9), at(6, 10)), entry(at(7, 9), at(7, 10))],
      lookup(),
      new Map(),
    );
    expect(
      aggregate(priced, 'week', { from: '2026-09-01', to: '2026-09-30', tz: TZ }).groups.map(
        (g) => g.key,
      ),
    ).toEqual(['2026-W36', '2026-W37']);
    expect(
      aggregate(priced, 'month', { from: '2026-09-01', to: '2026-09-30', tz: TZ }).groups[0],
    ).toMatchObject({
      key: '2026-09',
      seconds: 7200,
      count: 2,
    });
  });

  it('uses the lock’s frozen rounding for period-locked entries', () => {
    const lock = { id: 7, rounding_min: 30, rounding_mode: 'up' } as never;
    const priced = priceEntries(
      [
        entry(at(1, 9), at(1, 9, 5), {
          period_lock_id: 7,
          rate_locked_at: 1,
          locked_rate: 100000,
          locked_currency: 'NOK',
        }),
      ],
      lookup({ rounding_min: 0 }),
      new Map([[7, lock]]),
    );
    expect(priced[0]).toMatchObject({ seconds: 1800, amount: 50000 });
  });

  it('builds an invoice basis split by description and rate, non-billable separate', () => {
    const priced = priceEntries(
      [
        entry(at(1, 9), at(1, 10), { description: 'Design' }),
        entry(at(2, 9), at(2, 10), { description: 'Design' }),
        entry(at(3, 9), at(3, 10), {
          description: 'Design',
          rate_locked_at: 1,
          locked_rate: 90000,
          locked_currency: 'NOK',
        }),
        entry(at(4, 9), at(4, 10), { description: 'Internal', billable: 0 }),
      ],
      lookup(),
      new Map(),
    );
    const b = invoiceBasis(priced);
    expect(b.projects[0]!.lines.map((l) => [l.description, l.seconds, l.rate, l.amount])).toEqual([
      ['Design', 7200, 100000, 200000],
      ['Design', 3600, 90000, 90000],
    ]);
    expect(b.non_billable).toHaveLength(1);
    expect(b.totals).toEqual({
      seconds: 3 * 3600,
      amounts: { NOK: 290000 },
      non_billable_seconds: 3600,
    });
  });
});

describe('csv helpers', () => {
  it('follows the locale: nb uses ; and , — en uses , and .', () => {
    expect(csvFormatFor('nb')).toEqual({ sep: ';', decimal: ',' });
    expect(csvFormatFor('en')).toEqual({ sep: ',', decimal: '.' });
  });

  it('quotes, localises numbers and neutralises formulas', () => {
    const nb = csvFormatFor('nb');
    expect(csvCell('a;b', nb)).toBe('"a;b"');
    expect(csvCell('say "hi"', nb)).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak', nb)).toBe('"line\nbreak"');
    expect(csvCell('7.75', nb)).toBe('7,75');
    expect(csvCell('-12.50', nb)).toBe('-12,50');
    expect(csvCell('=SUM(A1)', nb)).toBe("'=SUM(A1)");
    expect(csvCell('=HYPERLINK("x")', nb)).toBe('"\'=HYPERLINK(""x"")"');
    expect(minorToDecimal(120050, 2)).toBe('1200.50');
    expect(minorToDecimal(1200, 0)).toBe(1200);
  });
});
