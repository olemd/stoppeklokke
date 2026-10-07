// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  amountFor,
  distribute,
  formatHM,
  parseDuration,
  roundDuration,
  splitByDay,
} from '../src/core/time/duration';
import {
  formatDate,
  formatDecimalHours,
  formatMoney,
  formatTime,
  parseClock,
} from '../src/core/time/format';
import {
  addDays,
  dateOf,
  dateRangeBounds,
  endOfMonth,
  isValidCurrency,
  isValidTimeZone,
  isoWeek,
  startOfDay,
  startOfWeek,
  zonedToEpoch,
} from '../src/core/time/tz';

const OSLO = 'Europe/Oslo';
const at = (iso: string) => Date.parse(iso) / 1000;

describe('time zones', () => {
  it('converts wall-clock time in a zone to epoch, across DST', () => {
    expect(zonedToEpoch(2026, 1, 15, 9, 0, OSLO)).toBe(at('2026-01-15T08:00:00Z'));
    expect(zonedToEpoch(2026, 7, 15, 9, 0, OSLO)).toBe(at('2026-07-15T07:00:00Z'));
    expect(zonedToEpoch(2026, 7, 15, 9, 0, 'America/New_York')).toBe(at('2026-07-15T13:00:00Z'));
  });

  it('computes day bounds in the zone, with 23 h and 25 h DST days', () => {
    const spring = dateRangeBounds('2026-03-29', '2026-03-29', OSLO);
    expect(spring.end - spring.start).toBe(23 * 3600);
    const autumn = dateRangeBounds('2026-10-25', '2026-10-25', OSLO);
    expect(autumn.end - autumn.start).toBe(25 * 3600);
    expect(startOfDay('2026-10-07', 'UTC')).toBe(at('2026-10-07T00:00:00Z'));
  });

  it('gives the calendar date of an instant in the zone', () => {
    expect(dateOf(at('2026-10-06T23:30:00Z'), OSLO)).toBe('2026-10-07');
    expect(dateOf(at('2026-10-06T23:30:00Z'), 'UTC')).toBe('2026-10-06');
  });

  it('does calendar arithmetic and ISO weeks', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(startOfWeek('2026-10-07')).toBe('2026-10-05');
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(isoWeek('2026-01-01')).toEqual({ year: 2026, week: 1 });
    expect(isoWeek('2027-01-01')).toEqual({ year: 2026, week: 53 });
  });

  it('validates zones and currencies', () => {
    expect(isValidTimeZone('Europe/Oslo')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidCurrency('NOK')).toBe(true);
    expect(isValidCurrency('XYZ')).toBe(false);
  });
});

describe('formatting (§3)', () => {
  const t = at('2026-10-07T12:30:00Z');

  it('uses 24-hour clock with locale=en unless 12h is chosen', () => {
    expect(formatTime(t, { timezone: OSLO, locale: 'en', clock: '24h' })).toBe('14:30');
    expect(formatTime(t, { timezone: OSLO, locale: 'en', clock: '12h' })).toMatch(/2:30\s?pm/i);
    expect(formatTime(t, { timezone: OSLO, locale: 'nb', clock: '24h' })).toBe('14:30');
  });

  it('formats in the configured zone, not the runtime zone', () => {
    expect(formatTime(t, { timezone: 'America/New_York', locale: 'en', clock: '24h' })).toBe(
      '08:30',
    );
  });

  it('formats short dates per locale', () => {
    expect(formatDate(t, { timezone: OSLO, locale: 'en', clock: '24h' })).toBe('Wed 7 Oct');
    expect(formatDate(t, { timezone: OSLO, locale: 'nb', clock: '24h' })).toBe('ons. 7. okt.');
  });

  it('formats decimal hours and money per locale', () => {
    expect(formatDecimalHours(7.75 * 3600, 'en')).toBe('7.75');
    expect(formatDecimalHours(7.75 * 3600, 'nb')).toBe('7,75');
    expect(formatMoney(120000, 'NOK', 'nb')).toMatch(/1\s200,00\s?kr/);
    expect(formatMoney(120000, 'EUR', 'en')).toBe('€1,200.00');
  });

  it('parses typed clock times', () => {
    expect(parseClock('9')).toEqual({ hour: 9, minute: 0 });
    expect(parseClock('0930')).toEqual({ hour: 9, minute: 30 });
    expect(parseClock('14:05')).toEqual({ hour: 14, minute: 5 });
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('2:30 PM')).toBeNull();
  });
});

describe('durations', () => {
  it('formats H:MM', () => {
    expect(formatHM(7 * 3600 + 45 * 60)).toBe('7:45');
    expect(formatHM(59)).toBe('0:00');
  });

  it('rounds per mode', () => {
    expect(roundDuration(7 * 60 + 29, 15, 'nearest')).toBe(0);
    expect(roundDuration(7 * 60 + 30, 15, 'nearest')).toBe(15 * 60);
    expect(roundDuration(61, 15, 'up')).toBe(15 * 60);
    expect(roundDuration(29 * 60, 15, 'down')).toBe(15 * 60);
    expect(roundDuration(1234, 0, 'up')).toBe(1234);
    expect(roundDuration(13 * 60, 6, 'nearest')).toBe(12 * 60);
  });

  it('computes amounts in integer minor units, half-up', () => {
    expect(amountFor(3600, 100000)).toBe(100000);
    expect(amountFor(1800, 1)).toBe(1); // 0.5 → 1
    expect(amountFor(1799, 1)).toBe(0);
    expect(amountFor(45 * 60, 150000)).toBe(112500);
  });

  it('parses typed durations', () => {
    expect(parseDuration('1:30')).toBe(5400);
    expect(parseDuration('1h30m')).toBe(5400);
    expect(parseDuration('1,5')).toBe(5400);
    expect(parseDuration('90')).toBe(5400);
    expect(parseDuration('abc')).toBeNull();
  });

  it('splits entries across midnight in the zone', () => {
    const start = zonedToEpoch(2026, 10, 7, 22, 0, OSLO);
    const end = zonedToEpoch(2026, 10, 8, 2, 30, OSLO);
    expect(splitByDay(start, end, OSLO)).toEqual([
      { date: '2026-10-07', seconds: 2 * 3600 },
      { date: '2026-10-08', seconds: 2.5 * 3600 },
    ]);
  });

  it('distributes rounded totals exactly', () => {
    expect(distribute(900, [7200, 9000])).toEqual([400, 500]);
    expect(distribute(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(distribute(10, [0, 0])).toEqual([0, 0]);
  });
});
