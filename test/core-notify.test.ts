// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { inQuietHours, planNotifications, rearm, type PlanInput } from '../src/core/notify/plan';
import { zonedToEpoch } from '../src/core/time/tz';

const TZ = 'Europe/Oslo';
const noon = zonedToEpoch(2026, 10, 7, 12, 0, TZ);
const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  startAt: noon,
  now: noon,
  alertAfterMin: 240,
  tickIntervalMin: 60,
  idleStopAfterMin: 0,
  quietHours: '23:00-07:00',
  timezone: TZ,
  sent: new Set(),
  ...over,
});

describe('planNotifications (§8.2)', () => {
  it('sends nothing before the first tick', () => {
    expect(planNotifications(base({ now: noon + 59 * 60 }))).toMatchObject({
      alert: false,
      tick: null,
    });
  });

  it('ticks once per interval, only the latest', () => {
    expect(planNotifications(base({ now: noon + 3600 })).tick).toBe(1);
    expect(
      planNotifications(base({ now: noon + 3600, sent: new Set(['tick:1']) })).tick,
    ).toBeNull();
    expect(
      planNotifications(base({ now: noon + 3 * 3600 + 5, sent: new Set(['tick:1']) })).tick,
    ).toBe(3);
  });

  it('alerts once after 4 h', () => {
    expect(
      planNotifications(base({ now: noon + 4 * 3600, sent: new Set(['tick:4']) })),
    ).toMatchObject({ alert: true, tick: null });
    expect(
      planNotifications(base({ now: noon + 5 * 3600, sent: new Set(['alert:0', 'tick:5']) })).alert,
    ).toBe(false);
  });

  it('respects quiet hours for ticks but not alerts', () => {
    const late = zonedToEpoch(2026, 10, 7, 19, 0, TZ);
    const p = planNotifications(base({ startAt: late, now: late + 4 * 3600 + 60 }));
    expect(p).toMatchObject({ alert: true, tick: null });
  });

  it('honours 0 = off for ticks and alerts', () => {
    expect(
      planNotifications(base({ now: noon + 9 * 3600, tickIntervalMin: 0, alertAfterMin: 0 })),
    ).toMatchObject({ alert: false, tick: null });
  });

  it('auto-stops at start + idle_stop_after_min when enabled', () => {
    expect(planNotifications(base({ now: noon + 3 * 3600, idleStopAfterMin: 120 }))).toMatchObject({
      stopAt: noon + 7200,
    });
  });
});

describe('quiet hours', () => {
  it('handles windows that wrap midnight and same-day windows', () => {
    const at = (h: number, m = 0) => zonedToEpoch(2026, 10, 7, h, m, TZ);
    expect(inQuietHours(at(23, 30), '23:00-07:00', TZ)).toBe(true);
    expect(inQuietHours(at(6, 59), '23:00-07:00', TZ)).toBe(true);
    expect(inQuietHours(at(7, 0), '23:00-07:00', TZ)).toBe(false);
    expect(inQuietHours(at(12, 30), '12:00-13:00', TZ)).toBe(true);
    expect(inQuietHours(at(12, 30), '', TZ)).toBe(false);
  });
});

describe('rearm after the start time moves', () => {
  it('forgets ticks beyond the new count and an alert that is no longer due', () => {
    expect(rearm(90 * 60, 240, 60)).toEqual({ ticksAbove: 1, clearAlert: true });
    expect(rearm(5 * 3600, 240, 60)).toEqual({ ticksAbove: 5, clearAlert: false });
  });
});
