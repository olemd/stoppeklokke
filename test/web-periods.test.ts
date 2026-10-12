// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { matchPreset, presetRange, shiftRange } from '../src/web/lib/periods';

const today = '2026-10-14'; // a Wednesday

describe('report periods', () => {
  it('steps weeks by seven days', () => {
    const week = presetRange('thisWeek', today);
    expect(shiftRange(week, -1)).toEqual(presetRange('lastWeek', today));
    expect(shiftRange(week, 1)).toEqual({ from: '2026-10-19', to: '2026-10-25' });
  });

  it('steps whole months by calendar months, across years', () => {
    expect(shiftRange({ from: '2026-03-01', to: '2026-03-31' }, -1)).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(shiftRange({ from: '2026-01-01', to: '2026-01-31' }, -1)).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(shiftRange(presetRange('thisYear', today), 1)).toEqual({
      from: '2027-01-01',
      to: '2027-12-31',
    });
  });

  it('steps any other range by its length', () => {
    expect(shiftRange({ from: '2026-10-10', to: '2026-10-12' }, 1)).toEqual({
      from: '2026-10-13',
      to: '2026-10-15',
    });
  });

  it('recognises presets so a stepped period keeps its name', () => {
    expect(matchPreset(shiftRange(presetRange('thisMonth', today), -1), today)).toBe('lastMonth');
    expect(matchPreset({ from: '2026-08-01', to: '2026-08-31' }, today)).toBe('custom');
  });
});
