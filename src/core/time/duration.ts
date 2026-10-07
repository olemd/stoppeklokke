// SPDX-License-Identifier: AGPL-3.0-or-later
/** Durations, rounding and splitting across days (§3, §9). Pure functions. */
import { addDays, dateOf, startOfDay } from './tz';

export type RoundingMode = 'nearest' | 'up' | 'down';
export const ROUNDING_STEPS = [0, 5, 6, 10, 15, 30] as const;

/**
 * Round a duration (seconds) to a multiple of `stepMin` minutes. Applied per
 * entry before summing, only in reports/exports (§9); raw data is never changed.
 * `nearest` rounds halves up.
 */
export function roundDuration(seconds: number, stepMin: number, mode: RoundingMode): number {
  if (!stepMin || seconds <= 0) return Math.max(0, seconds);
  const step = stepMin * 60;
  switch (mode) {
    case 'up':
      return Math.ceil(seconds / step) * step;
    case 'down':
      return Math.floor(seconds / step) * step;
    default:
      return Math.floor((seconds + step / 2) / step) * step;
  }
}

/** Amount in minor units for `seconds` at `rate` minor units/hour, rounded half-up (§4). */
export function amountFor(seconds: number, rate: number): number {
  const v = rate * seconds;
  return v >= 0 ? Math.floor((v + 1800) / 3600) : -Math.floor((-v + 1800) / 3600);
}

/** `H:MM` (e.g. 7:45). Negative durations are clamped to 0:00. */
export function formatHM(seconds: number): string {
  const totalMin = Math.max(0, Math.floor(seconds / 60));
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`;
}

/** `H:MM:SS` for the running stopwatch. */
export function formatHMS(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Parse `H:MM`, `HH:MM`, `1h30m`, `1.5`/`1,5` (hours) or plain minutes into seconds. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  let m = /^(\d+):([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60;
  m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/.exec(s);
  if (m && (m[1] || m[2])) return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60;
  m = /^(\d+)[.,](\d+)$/.exec(s);
  if (m) return Math.round(Number(`${m[1]}.${m[2]}`) * 3600);
  m = /^(\d+)$/.exec(s);
  if (m) return Number(m[1]) * 60;
  return null;
}

/**
 * Split [start, end) into per-day pieces in `tz` (§9: an entry crossing
 * midnight is split proportionally in day grouping). Returns seconds per date.
 */
export function splitByDay(
  start: number,
  end: number,
  tz: string,
): { date: string; seconds: number }[] {
  const out: { date: string; seconds: number }[] = [];
  let date = dateOf(start, tz);
  let cursor = start;
  while (cursor < end) {
    const next = startOfDay(addDays(date, 1), tz);
    const stop = Math.min(end, next);
    out.push({ date, seconds: stop - cursor });
    cursor = stop;
    date = addDays(date, 1);
  }
  return out;
}

/**
 * Distribute an entry's rounded duration over its day pieces proportionally,
 * keeping the total exact (largest remainder), so split days sum to the entry.
 */
export function distribute(total: number, parts: number[]): number[] {
  const raw = parts.reduce((a, b) => a + b, 0);
  if (raw <= 0) return parts.map(() => 0);
  const exact = parts.map((p) => (p * total) / raw);
  const floored = exact.map(Math.floor);
  let rest = total - floored.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    floored[i]!++;
    rest--;
  }
  return floored;
}
