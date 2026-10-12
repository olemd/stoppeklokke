// SPDX-License-Identifier: AGPL-3.0-or-later
/** Report period presets (§7.1 #3), as calendar dates in the configured zone. */
import { addDays, endOfMonth, parseDate, startOfMonth, startOfWeek } from '../../core/time/tz';

export type Preset = 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'custom';
export const PRESETS: Preset[] = [
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'thisYear',
  'custom',
];

export interface Range {
  from: string;
  to: string;
}

export function presetRange(p: Exclude<Preset, 'custom'>, today: string): Range {
  switch (p) {
    case 'thisWeek': {
      const s = startOfWeek(today);
      return { from: s, to: addDays(s, 6) };
    }
    case 'lastWeek': {
      const s = addDays(startOfWeek(today), -7);
      return { from: s, to: addDays(s, 6) };
    }
    case 'thisMonth':
      return { from: startOfMonth(today), to: endOfMonth(today) };
    case 'lastMonth': {
      const prev = addDays(startOfMonth(today), -1);
      return { from: startOfMonth(prev), to: endOfMonth(prev) };
    }
    case 'thisYear':
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
  }
}

/** The preset that yields exactly `r` today, or 'custom'. */
export function matchPreset(r: Range, today: string): Preset {
  for (const p of PRESETS)
    if (p !== 'custom') {
      const x = presetRange(p, today);
      if (x.from === r.from && x.to === r.to) return p;
    }
  return 'custom';
}

/** Months since year 0, for whole-month arithmetic. */
const monthIndex = (date: string) => {
  const { year, month } = parseDate(date);
  return year * 12 + month - 1;
};
const firstOfMonth = (index: number) =>
  `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}-01`;

/**
 * The period before (`dir` -1) or after (+1) `r`, the same size. Whole
 * calendar months (a month, a year, a quarter) step by months so they stay
 * whole months; anything else steps by its length in days (a week by 7).
 */
export function shiftRange(r: Range, dir: 1 | -1): Range {
  if (r.from === startOfMonth(r.from) && r.to === endOfMonth(r.to)) {
    const n = (monthIndex(r.to) - monthIndex(r.from) + 1) * dir;
    return {
      from: firstOfMonth(monthIndex(r.from) + n),
      to: endOfMonth(firstOfMonth(monthIndex(r.to) + n)),
    };
  }
  const { year: fy, month: fm, day: fd } = parseDate(r.from);
  const { year: ty, month: tm, day: td } = parseDate(r.to);
  const days = (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000 + 1;
  return { from: addDays(r.from, days * dir), to: addDays(r.to, days * dir) };
}
