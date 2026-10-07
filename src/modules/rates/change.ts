// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Rate change with locking of unlocked time (§4.2).
 *
 * "Affected" entries are completed, not rate-locked, and get their rate (or
 * currency, when the currency changes) from the level being changed, before
 * or after the change. The SQL mirrors resolveRate(): project → client →
 * workspace → global.
 * Everything is set-based so it fits the 10 ms CPU budget at any data size.
 */
import { badRequest, conflict } from '../../core/errors';
import type { Stmt } from '../../core/ports';
import type { Settings } from '../../core/settings/defs';
import { resolveSetting } from '../../core/settings/resolve';
import { getClient, getProject, getWorkspace, loadSettings } from '../data/repo';
import type { Ctx } from '../types';

export type RateLevel = 'project' | 'client' | 'workspace' | 'default';
export type RateChangeMode = 'lock' | 'lock_before' | 'update';

const FROM = `FROM time_entries e
  LEFT JOIN projects p ON p.id = e.project_id
  LEFT JOIN clients c ON c.id = COALESCE(p.client_id, e.client_id)
  JOIN workspaces w ON w.id = e.workspace_id`;

/**
 * Columns more specific than each level. An entry's resolved value comes from
 * (or, after the change, will come from) level L exactly when none of the
 * more specific levels has a non-NULL value. This also covers a level going
 * from "inherit" to a value (NULL → X) and back (X → NULL), where the entry's
 * *current* source is a less specific level but its value still changes.
 */
const MORE_SPECIFIC: Record<RateLevel, string[]> = {
  project: [],
  client: ['p'],
  workspace: ['p', 'c'],
  default: ['p', 'c', 'w'],
};
const COLUMN: Record<'rate' | 'currency', Record<string, string>> = {
  rate: { p: 'p.hourly_rate', c: 'c.hourly_rate', w: 'w.default_hourly_rate' },
  currency: { p: 'p.currency', c: 'c.currency', w: 'w.currency' },
};

interface Target {
  level: RateLevel;
  id: number | null;
  rateChanged: boolean;
  currencyChanged: boolean;
}

/** WHERE clause + params selecting the entries whose rate/currency the change affects. */
function affected(
  t: Target,
  before?: number,
): { where: string; params: (number | string | null)[] } {
  const inherits = (kind: 'rate' | 'currency') => {
    const cols = MORE_SPECIFIC[t.level].map((a) => `${COLUMN[kind][a]} IS NULL`);
    return cols.length ? `(${cols.join(' AND ')})` : '1';
  };
  const sources: string[] = [];
  if (t.rateChanged) sources.push(inherits('rate'));
  if (t.currencyChanged) sources.push(inherits('currency'));
  const parts = ['e.end_at IS NOT NULL', 'e.rate_locked_at IS NULL', `(${sources.join(' OR ')})`];
  const params: (number | string | null)[] = [];
  if (t.level === 'project') parts.push('p.id = ?');
  if (t.level === 'client') parts.push('c.id = ?');
  if (t.level === 'workspace') parts.push('w.id = ?');
  if (t.level !== 'default') params.push(t.id);
  if (before !== undefined) {
    parts.push('e.start_at < ?');
    params.push(before);
  }
  return { where: parts.join(' AND '), params };
}

export interface Impact {
  count: number;
  seconds: number;
  oldest: number | null;
  newest: number | null;
  current_rate: number | null;
  currency: string;
}

async function currentValues(ctx: Ctx, level: RateLevel, id: number | null, s: Settings) {
  if (level === 'project' && id) {
    const p = await getProject(ctx, id);
    return { rate: p?.hourly_rate ?? null, currency: p?.currency ?? s.currency };
  }
  if (level === 'client' && id) {
    const c = await getClient(ctx, id);
    return { rate: c?.hourly_rate ?? null, currency: c?.currency ?? s.currency };
  }
  if (level === 'workspace' && id) {
    const w = await getWorkspace(ctx, id);
    return { rate: w?.default_hourly_rate ?? null, currency: w?.currency ?? s.currency };
  }
  return { rate: s.default_hourly_rate, currency: s.currency };
}

/** GET /api/rates/impact: what a rate (and currency) change at this level would touch. */
export async function rateImpact(
  ctx: Ctx,
  level: RateLevel,
  id: number | null,
  change: { rate: boolean; currency: boolean } = { rate: true, currency: false },
): Promise<Impact> {
  const s = await loadSettings(ctx);
  const { where, params } = affected({
    level,
    id,
    rateChanged: change.rate,
    currencyChanged: change.currency,
  });
  const row = await ctx.db.first<{
    n: number;
    secs: number | null;
    oldest: number | null;
    newest: number | null;
  }>(
    `SELECT COUNT(*) AS n, SUM(e.end_at - e.start_at) AS secs, MIN(e.start_at) AS oldest, MAX(e.start_at) AS newest
     ${FROM} WHERE ${where}`,
    ...params,
  );
  const cur = await currentValues(ctx, level, id, s);
  return {
    count: row?.n ?? 0,
    seconds: row?.secs ?? 0,
    oldest: row?.oldest ?? null,
    newest: row?.newest ?? null,
    current_rate: cur.rate,
    currency: cur.currency,
  };
}

/** The UPDATE that freezes the OLD resolved rate/currency on affected entries. */
/**
 * Freeze the currently resolved rate and currency on the entries matched by
 * `where` (aliases e/p/c/w as in FROM). Used by rate changes, manual rate
 * locks and period locks; one set-based UPDATE regardless of data size.
 */
export function freezeRates(
  where: string,
  params: (number | string | null)[],
  s: Pick<Settings, 'default_hourly_rate' | 'currency'>,
  lockedAt: number,
): Stmt {
  return {
    sql: `UPDATE time_entries AS t
            SET rate_locked_at = ?, locked_rate = a.r, locked_currency = a.cu, updated_at = ?
            FROM (SELECT e.id AS id,
                         COALESCE(p.hourly_rate, c.hourly_rate, w.default_hourly_rate, ?) AS r,
                         COALESCE(p.currency, c.currency, w.currency, ?) AS cu
                  ${FROM} WHERE ${where}) AS a
           WHERE t.id = a.id`,
    params: [lockedAt, lockedAt, s.default_hourly_rate, s.currency, ...params],
  };
}

function lockStatement(t: Target, s: Settings, lockedAt: number, before?: number): Stmt {
  const { where, params } = affected(t, before);
  return freezeRates(where, params, s, lockedAt);
}

export interface RateChangePlan {
  /** Statements to run FIRST in the same batch as the rate update. */
  stmts: Stmt[];
  lockedAt: number | null;
  mode: RateChangeMode | null;
}

/**
 * Decide what a rate/currency change does to history (§4.2 steps 2-4).
 * Throws 409 with the impact when on_rate_change = ask and the request did not
 * say what to do: old clients and API scripts can never silently rewrite history.
 */
export async function planRateChange(
  ctx: Ctx,
  t: Target,
  rateChange: { mode: RateChangeMode; before?: number } | undefined,
): Promise<RateChangePlan> {
  const none: RateChangePlan = { stmts: [], lockedAt: null, mode: null };
  if (!t.rateChanged && !t.currencyChanged) return none;
  const s = await loadSettings(ctx);
  const { where, params } = affected(t);
  const count =
    (await ctx.db.first<{ n: number }>(`SELECT COUNT(*) AS n ${FROM} WHERE ${where}`, ...params))
      ?.n ?? 0;
  if (count === 0) return none;

  let mode = rateChange?.mode;
  if (!mode) {
    const workspace =
      t.level === 'workspace' && t.id
        ? await getWorkspace(ctx, t.id)
        : t.level === 'client' && t.id
          ? await getClient(ctx, t.id).then((c) => (c ? getWorkspace(ctx, c.workspace_id) : null))
          : t.level === 'project' && t.id
            ? await getProject(ctx, t.id).then((p) =>
                p ? getWorkspace(ctx, p.workspace_id) : null,
              )
            : null;
    const setting = resolveSetting('on_rate_change', { workspace, settings: s });
    if (setting === 'ask') {
      throw conflict(
        'rate_change_required',
        'This change affects existing time: choose how to handle it',
        {
          impact: await rateImpact(ctx, t.level, t.id, {
            rate: t.rateChanged,
            currency: t.currencyChanged,
          }),
        },
      );
    }
    mode = setting;
  }
  if (mode === 'update') return { stmts: [], lockedAt: null, mode };
  if (mode === 'lock_before' && rateChange?.before === undefined) {
    throw badRequest('before_required', 'rate_change.before is required for lock_before');
  }
  const lockedAt = ctx.clock.now();
  return {
    stmts: [lockStatement(t, s, lockedAt, mode === 'lock_before' ? rateChange!.before : undefined)],
    lockedAt,
    mode,
  };
}

/** Run plan + update atomically; returns how many entries were rate-locked. */
export async function runWithPlan(
  ctx: Ctx,
  plan: RateChangePlan,
  update: Stmt[],
  event: { level: RateLevel; id: number | null },
): Promise<{ locked: number; locked_at: number | null }> {
  const results = await ctx.db.batch([...plan.stmts, ...update]);
  const locked = plan.stmts.length ? (results[0]?.changes ?? 0) : 0;
  if (plan.mode) {
    ctx.events.emit({
      type: 'rate.changed',
      level: event.level,
      id: event.id,
      mode: plan.mode,
      locked,
    });
  }
  return { locked, locked_at: plan.lockedAt };
}
