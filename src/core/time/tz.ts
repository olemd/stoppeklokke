// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Time-zone arithmetic with Intl only (no tz database in the bundle, §3).
 *
 * All instants are UTC epoch seconds. Calendar dates are 'YYYY-MM-DD' strings
 * interpreted in an explicit IANA time zone — never the runtime's zone.
 * Intl.DateTimeFormat construction is the expensive part, so formatters are
 * cached per zone (10 ms CPU budget per request).
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function zonedParts(epoch: number, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(epoch * 1000)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday!] ?? 1,
  };
}

/** Offset of `tz` from UTC at `epoch`, in seconds (e.g. +7200 for Oslo in summer). */
export function tzOffset(epoch: number, tz: string): number {
  const p = zonedParts(epoch, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - epoch;
}

/**
 * Epoch for a wall-clock time in `tz`. For times skipped by a DST jump the
 * result is shifted forward; for repeated times the first occurrence wins.
 */
export function zonedToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
  second = 0,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  let epoch = naive - tzOffset(naive, tz);
  const corrected = naive - tzOffset(epoch, tz);
  if (corrected !== epoch) epoch = Math.min(epoch, corrected);
  return epoch;
}

export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(date: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid date: ${date}`);
  }
  return { year, month, day };
}

export function isValidDate(date: string): boolean {
  try {
    parseDate(date);
    return true;
  } catch {
    return false;
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatDateParts(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Calendar date of `epoch` in `tz`. */
export function dateOf(epoch: number, tz: string): string {
  const p = zonedParts(epoch, tz);
  return formatDateParts(p.year, p.month, p.day);
}

/** Pure calendar arithmetic on 'YYYY-MM-DD' (no time zone involved). */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return formatDateParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** ISO weekday (1 = Monday) of a calendar date. */
export function weekdayOf(date: string): number {
  const { year, month, day } = parseDate(date);
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Monday of the ISO week containing `date`. */
export function startOfWeek(date: string): string {
  return addDays(date, 1 - weekdayOf(date));
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: string): string {
  const { year, month } = parseDate(date);
  const d = new Date(Date.UTC(year, month, 0));
  return formatDateParts(year, month, d.getUTCDate());
}

/** ISO week number and ISO week-year of a calendar date. */
export function isoWeek(date: string): { year: number; week: number } {
  const thursday = addDays(date, 4 - weekdayOf(date));
  const { year } = parseDate(thursday);
  const jan1 = Date.UTC(year, 0, 1);
  const { month, day } = parseDate(thursday);
  const dayOfYear = (Date.UTC(year, month - 1, day) - jan1) / 86400000;
  return { year, week: Math.floor(dayOfYear / 7) + 1 };
}

/** Epoch of 00:00 on `date` in `tz`. */
export function startOfDay(date: string, tz: string): number {
  const { year, month, day } = parseDate(date);
  return zonedToEpoch(year, month, day, 0, 0, tz);
}

/**
 * Epoch bounds of an inclusive date range in `tz`: [from 00:00, day after `to` 00:00).
 * Day boundaries are computed in the zone, so DST days are 23 or 25 hours long.
 */
export function dateRangeBounds(
  from: string,
  to: string,
  tz: string,
): { start: number; end: number } {
  return { start: startOfDay(from, tz), end: startOfDay(addDays(to, 1), tz) };
}

let zoneSet: Set<string> | null = null;

/** Validates an IANA zone against Intl.supportedValuesOf('timeZone') (§4.3). */
export function isValidTimeZone(tz: string): boolean {
  if (tz === 'UTC') return true;
  zoneSet ??= new Set(Intl.supportedValuesOf('timeZone'));
  return zoneSet.has(tz);
}

let currencySet: Set<string> | null = null;

/** Validates an ISO 4217 code against Intl.supportedValuesOf('currency'). */
export function isValidCurrency(code: string): boolean {
  currencySet ??= new Set(Intl.supportedValuesOf('currency'));
  return currencySet.has(code);
}
