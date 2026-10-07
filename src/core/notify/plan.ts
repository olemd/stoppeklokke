// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the cron run should do for the running entry (§8.2, §8.3). Pure.
 *
 * - Alert once when the session reaches alert_after_min (0 = off).
 * - Tick n = floor(d / interval) once per n ≥ 1, outside quiet hours
 *   (alerts still go out in quiet hours). Only the latest tick is sent; a
 *   missed tick is not sent late.
 * - Auto-stop at start + idle_stop_after_min when enabled (off by default).
 */
import { zonedParts } from '../time/tz';

export interface PlanInput {
  startAt: number;
  now: number;
  alertAfterMin: number;
  tickIntervalMin: number;
  idleStopAfterMin: number;
  quietHours: string;
  timezone: string;
  /** Already logged, as "kind:seq" (e.g. "alert:0", "tick:2"). */
  sent: Set<string>;
}

export interface Plan {
  stopAt: number | null;
  alert: boolean;
  tick: number | null;
  /** Elapsed seconds at `now` (or at the auto-stop time). */
  duration: number;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** True when `epoch` falls inside "HH:MM-HH:MM" in `tz` (may wrap midnight). */
export function inQuietHours(epoch: number, quiet: string, tz: string): boolean {
  if (!quiet) return false;
  const [from, to] = quiet.split('-');
  const start = minutesOf(from!);
  const end = minutesOf(to!);
  if (start === end) return false;
  const p = zonedParts(epoch, tz);
  const m = p.hour * 60 + p.minute;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export function planNotifications(i: PlanInput): Plan {
  if (i.idleStopAfterMin > 0 && i.now - i.startAt >= i.idleStopAfterMin * 60) {
    const stopAt = i.startAt + i.idleStopAfterMin * 60;
    return { stopAt, alert: false, tick: null, duration: stopAt - i.startAt };
  }
  const d = Math.max(0, i.now - i.startAt);
  const alert = i.alertAfterMin > 0 && d >= i.alertAfterMin * 60 && !i.sent.has('alert:0');
  let tick: number | null = null;
  if (i.tickIntervalMin > 0) {
    const n = Math.floor(d / (i.tickIntervalMin * 60));
    if (n >= 1 && !i.sent.has(`tick:${n}`) && !inQuietHours(i.now, i.quietHours, i.timezone))
      tick = n;
  }
  return { stopAt: null, alert, tick, duration: d };
}

/**
 * After the running entry's start time is edited, which log rows to forget so
 * notifications follow the new start (§13: "tick/alert computed from the new
 * start"): ticks beyond the new count, and the alert if it is no longer due.
 */
export function rearm(duration: number, alertAfterMin: number, tickIntervalMin: number) {
  return {
    ticksAbove: tickIntervalMin > 0 ? Math.floor(duration / (tickIntervalMin * 60)) : 0,
    clearAlert: alertAfterMin <= 0 || duration < alertAfterMin * 60,
  };
}
