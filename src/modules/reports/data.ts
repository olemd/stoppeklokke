// SPDX-License-Identifier: AGPL-3.0-or-later
/** Loads and prices the entries a report or lock preview covers. */
import { z } from '@hono/zod-openapi';
import { badRequest } from '../../core/errors';
import type { EntryRow, PeriodLockRow } from '../../core/model';
import type { RateLookup } from '../../core/rates/resolve';
import { priceEntries, type ReportEntry } from '../../core/reports/aggregate';
import { dateRangeBounds, isValidDate } from '../../core/time/tz';
import { DateStr, Id } from '../../shared/schemas';
import { loadLookup } from '../data/repo';
import type { Ctx } from '../types';

export const ReportQuery = z.object({
  from: DateStr,
  to: DateStr,
  workspace_id: Id.optional(),
  client_id: Id.optional(),
  project_id: Id.optional(),
  billable: z.enum(['true', 'false', 'all']).default('all'),
  locked: z.enum(['locked', 'unlocked', 'all']).default('all'),
});
export type ReportQuery = z.infer<typeof ReportQuery>;

export interface ReportData {
  lookup: RateLookup;
  priced: ReportEntry[];
  locks: Map<number, PeriodLockRow>;
  tz: string;
}

export function checkRange(from: string, to: string) {
  if (!isValidDate(from) || !isValidDate(to))
    throw badRequest('invalid_date', 'Invalid from/to date');
  if (from > to) throw badRequest('invalid_range', 'from must not be after to');
}

/** Completed entries starting in [from, to] (dates in the timezone setting), priced. */
export async function loadReport(ctx: Ctx, q: ReportQuery): Promise<ReportData> {
  checkRange(q.from, q.to);
  const lookup = await loadLookup(ctx);
  const tz = lookup.settings.timezone;
  const { start, end } = dateRangeBounds(q.from, q.to, tz);
  const where = ['end_at IS NOT NULL', 'start_at >= ?', 'start_at < ?'];
  const params: number[] = [start, end];
  for (const k of ['workspace_id', 'client_id', 'project_id'] as const) {
    if (q[k]) {
      where.push(`${k} = ?`);
      params.push(q[k]!);
    }
  }
  if (q.billable !== 'all') where.push(`billable = ${q.billable === 'true' ? 1 : 0}`);
  if (q.locked === 'locked') where.push('period_lock_id IS NOT NULL');
  if (q.locked === 'unlocked') where.push('period_lock_id IS NULL');
  const [rows, lockRows] = await Promise.all([
    ctx.db.all<EntryRow>(
      `SELECT * FROM time_entries WHERE ${where.join(' AND ')} ORDER BY start_at, id`,
      ...params,
    ),
    ctx.db.all<PeriodLockRow>('SELECT * FROM period_locks'),
  ]);
  const locks = new Map(lockRows.map((l) => [l.id, l]));
  return { lookup, priced: priceEntries(rows, lookup, locks), locks, tz };
}
