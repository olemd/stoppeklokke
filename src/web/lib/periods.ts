// SPDX-License-Identifier: AGPL-3.0-or-later
/** Report period presets (§7.1 #3), as calendar dates in the configured zone. */
import { addDays, endOfMonth, startOfMonth, startOfWeek } from '../../core/time/tz';

export type Preset = 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'custom';
export const PRESETS: Preset[] = [
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'thisYear',
  'custom',
];

export function presetRange(
  p: Exclude<Preset, 'custom'>,
  today: string,
): { from: string; to: string } {
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
