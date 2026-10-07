// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Report aggregation (§9). Pure and CPU-conscious:
 *
 * - Rounding is applied per entry before summing (period-locked entries use
 *   their lock's frozen rounding), only here — raw data never changes.
 * - Amounts: billable entries with a rate only, per entry, half-up, summed
 *   per currency; currencies are never combined.
 * - Day/week/month grouping splits entries across midnight in the configured
 *   time zone. Day boundaries are computed once per report (not per entry),
 *   so a year of data stays within the 10 ms CPU budget.
 */
import type { EntryRow, PeriodLockRow } from '../model';
import { resolveEntryRate, type RateLookup } from '../rates/resolve';
import { resolveSetting } from '../settings/resolve';
import { amountFor, distribute, roundDuration, type RoundingMode } from '../time/duration';
import { addDays, isoWeek, startOfDay } from '../time/tz';

export type GroupBy = 'workspace' | 'client' | 'project' | 'day' | 'week' | 'month';

export interface ReportEntry {
  entry: EntryRow;
  /** Rounded duration in seconds. */
  seconds: number;
  rate: number | null;
  currency: string;
  /** Amount in minor units; null when not billable or no rate. */
  amount: number | null;
  lock: PeriodLockRow | null;
}

export interface Totals {
  seconds: number;
  billable_seconds: number;
  /** Minor units per currency, only for currencies with an amount. */
  amounts: Record<string, number>;
  count: number;
}

export interface Group extends Totals {
  key: string;
  /** Workspace/client/project id for those groupings (null = uncategorised). */
  id: number | null;
  workspace_id: number | null;
}

export interface Report {
  groups: Group[];
  totals: Totals;
  /** Per calendar day (for the bar chart), in range order. */
  days: { date: string; seconds: number }[];
  /** False when no entry in the result has a rate: amount columns are hidden. */
  has_amounts: boolean;
}

const emptyTotals = (): Totals => ({ seconds: 0, billable_seconds: 0, amounts: {}, count: 0 });

function add(
  t: Totals,
  seconds: number,
  billable: boolean,
  amount: number | null,
  currency: string,
) {
  t.seconds += seconds;
  if (billable) t.billable_seconds += seconds;
  if (amount !== null) t.amounts[currency] = (t.amounts[currency] ?? 0) + amount;
}

/** Rounded duration, rate and amount for each completed entry. */
export function priceEntries(
  entries: EntryRow[],
  lookup: RateLookup,
  locks: Map<number, PeriodLockRow>,
): ReportEntry[] {
  return entries
    .filter((e) => e.end_at !== null)
    .map((entry) => {
      const lock = entry.period_lock_id !== null ? (locks.get(entry.period_lock_id) ?? null) : null;
      let stepMin: number;
      let mode: RoundingMode;
      if (lock) {
        stepMin = lock.rounding_min;
        mode = lock.rounding_mode as RoundingMode;
      } else {
        const workspace = lookup.workspaces.get(entry.workspace_id);
        stepMin = resolveSetting('rounding_min', { workspace, settings: lookup.settings });
        mode = resolveSetting('rounding_mode', { workspace, settings: lookup.settings });
      }
      const seconds = roundDuration(entry.end_at! - entry.start_at, stepMin, mode);
      const r = resolveEntryRate(entry, lookup);
      const amount = entry.billable === 1 && r.rate !== null ? amountFor(seconds, r.rate) : null;
      return { entry, seconds, rate: r.rate, currency: r.currency, amount, lock };
    });
}

/**
 * Epochs of 00:00 for each day from `from` through two days after `to`:
 * entries are selected by start date, so the last one may run past midnight
 * into `to + 1`; that piece must land on its real date, not be dropped.
 */
export function dayBoundaries(
  from: string,
  to: string,
  tz: string,
): { dates: string[]; starts: number[] } {
  const dates: string[] = [];
  const starts: number[] = [];
  for (let d = from; d <= addDays(to, 2); d = addDays(d, 1)) {
    dates.push(d);
    starts.push(startOfDay(d, tz));
  }
  return { dates, starts };
}

/** Largest index i with starts[i] <= t (binary search). */
function dayIndex(starts: number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Split an entry over the precomputed days; the ROUNDED duration is
 * distributed proportionally so the pieces sum to the entry exactly.
 */
function splitPieces(
  re: ReportEntry,
  b: { dates: string[]; starts: number[] },
): { date: string; seconds: number; amount: number | null }[] {
  const { start_at, end_at } = re.entry;
  const raw: { idx: number; secs: number }[] = [];
  let i = dayIndex(b.starts, start_at);
  let cursor = start_at;
  while (cursor < end_at! && i < b.dates.length - 1) {
    const stop = Math.min(end_at!, b.starts[i + 1]!);
    if (stop > cursor) raw.push({ idx: i, secs: stop - cursor });
    cursor = stop;
    i++;
  }
  if (raw.length === 0) return [];
  const secs = distribute(
    re.seconds,
    raw.map((r) => r.secs),
  );
  const amounts =
    re.amount === null
      ? null
      : distribute(
          re.amount,
          raw.map((r) => r.secs),
        );
  return raw.map((r, k) => ({
    date: b.dates[r.idx]!,
    seconds: secs[k]!,
    amount: amounts ? amounts[k]! : null,
  }));
}

const weekKey = (date: string) => {
  const w = isoWeek(date);
  return `${w.year}-W${String(w.week).padStart(2, '0')}`;
};

export function aggregate(
  priced: ReportEntry[],
  groupBy: GroupBy,
  range: { from: string; to: string; tz: string },
): Report {
  const b = dayBoundaries(range.from, range.to, range.tz);
  const groups = new Map<string, Group>();
  const totals = emptyTotals();
  const perDay = new Map<string, number>(b.dates.slice(0, -2).map((d) => [d, 0]));
  let hasAmounts = false;

  const group = (key: string, id: number | null, workspaceId: number | null) => {
    let g = groups.get(key);
    if (!g) {
      g = { key, id, workspace_id: workspaceId, ...emptyTotals() };
      groups.set(key, g);
    }
    return g;
  };

  for (const re of priced) {
    const e = re.entry;
    const billable = e.billable === 1;
    if (re.rate !== null) hasAmounts = true;
    add(totals, re.seconds, billable, re.amount, re.currency);
    totals.count++;
    const pieces = splitPieces(re, b);
    for (const p of pieces)
      if (perDay.has(p.date)) perDay.set(p.date, perDay.get(p.date)! + p.seconds);

    if (groupBy === 'workspace' || groupBy === 'client' || groupBy === 'project') {
      const id =
        groupBy === 'workspace'
          ? e.workspace_id
          : groupBy === 'client'
            ? e.client_id
            : e.project_id;
      const g = group(
        `${groupBy === 'workspace' ? '' : `${e.workspace_id}:`}${id ?? 'none'}`,
        id,
        e.workspace_id,
      );
      add(g, re.seconds, billable, re.amount, re.currency);
      g.count++;
    } else {
      const seen = new Set<string>();
      for (const p of pieces) {
        const key =
          groupBy === 'day' ? p.date : groupBy === 'week' ? weekKey(p.date) : p.date.slice(0, 7);
        const g = group(key, null, null);
        add(g, p.seconds, billable, p.amount, re.currency);
        if (!seen.has(key)) {
          g.count++;
          seen.add(key);
        }
      }
    }
  }

  const sorted = [...groups.values()];
  if (groupBy === 'day' || groupBy === 'week' || groupBy === 'month')
    sorted.sort((a, c) => a.key.localeCompare(c.key));
  else sorted.sort((a, c) => c.seconds - a.seconds);
  return {
    groups: sorted,
    totals,
    days: [...perDay.entries()].map(([date, seconds]) => ({ date, seconds })),
    has_amounts: hasAmounts,
  };
}

// ── Invoice basis (§9.2) ──────────────────────────────────────────────────

export interface InvoiceLine {
  project_id: number | null;
  description: string;
  seconds: number;
  rate: number | null;
  currency: string;
  amount: number | null;
  entries: ReportEntry[];
}

export interface InvoiceProject {
  project_id: number | null;
  lines: InvoiceLine[];
  seconds: number;
  amounts: Record<string, number>;
}

export interface InvoiceBasis {
  projects: InvoiceProject[];
  /** Non-billable time, listed separately as "not invoiced". */
  non_billable: InvoiceLine[];
  totals: { seconds: number; amounts: Record<string, number>; non_billable_seconds: number };
}

/**
 * Group client → project → description. Lines are split further by rate and
 * currency so every line has one price (rate-locked entries may differ).
 */
export function invoiceBasis(priced: ReportEntry[]): InvoiceBasis {
  const lineKey = (r: ReportEntry) =>
    `${r.entry.project_id ?? 'none'}|${r.entry.description}|${r.rate ?? 'none'}|${r.currency}`;
  const billable = new Map<string, InvoiceLine>();
  const nonBillable = new Map<string, InvoiceLine>();
  for (const r of [...priced].sort((a, b) => a.entry.start_at - b.entry.start_at)) {
    const target = r.entry.billable === 1 ? billable : nonBillable;
    const k = lineKey(r);
    let line = target.get(k);
    if (!line) {
      line = {
        project_id: r.entry.project_id,
        description: r.entry.description,
        seconds: 0,
        rate: r.rate,
        currency: r.currency,
        amount: null,
        entries: [],
      };
      target.set(k, line);
    }
    line.seconds += r.seconds;
    if (r.amount !== null) line.amount = (line.amount ?? 0) + r.amount;
    line.entries.push(r);
  }
  const projects = new Map<string, InvoiceProject>();
  const totals = { seconds: 0, amounts: {} as Record<string, number>, non_billable_seconds: 0 };
  for (const line of billable.values()) {
    const k = String(line.project_id ?? 'none');
    let p = projects.get(k);
    if (!p) {
      p = { project_id: line.project_id, lines: [], seconds: 0, amounts: {} };
      projects.set(k, p);
    }
    p.lines.push(line);
    p.seconds += line.seconds;
    totals.seconds += line.seconds;
    if (line.amount !== null) {
      p.amounts[line.currency] = (p.amounts[line.currency] ?? 0) + line.amount;
      totals.amounts[line.currency] = (totals.amounts[line.currency] ?? 0) + line.amount;
    }
  }
  for (const line of nonBillable.values()) totals.non_billable_seconds += line.seconds;
  for (const p of projects.values())
    p.lines.sort((a, b) => a.description.localeCompare(b.description));
  return { projects: [...projects.values()], non_billable: [...nonBillable.values()], totals };
}
