// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Time entry rules shared by the timer and entries modules (§4, §6):
 * workspace/client/project derivation, time validation, period-lock and
 * rate-lock rules, and the timer's atomic start/stop.
 */
import { HttpError, badRequest, conflict } from '../../core/errors';
import type {
  ClientRow,
  EntryRow,
  PeriodLockRow,
  ProjectRow,
  WorkspaceRow,
} from '../../core/model';
import type { BatchResult, Stmt } from '../../core/ports';
import { resolveEntryRate, type RateLookup } from '../../core/rates/resolve';
import type { Settings } from '../../core/settings/defs';
import { resolveSetting } from '../../core/settings/resolve';
import type { Entry } from '../../shared/schemas';
import {
  activeWorkspaceId,
  loadSettings,
  requireClient,
  requireProject,
  requireWorkspace,
} from '../data/repo';
import type { Ctx } from '../types';

export const MAX_DURATION = 24 * 3600;
export const FUTURE_SLACK = 5 * 60;

export interface RefsInput {
  workspace_id?: number | null;
  client_id?: number | null;
  project_id?: number | null;
}

export interface Scope {
  workspace_id: number;
  client_id: number | null;
  project_id: number | null;
  workspace: WorkspaceRow;
  client: ClientRow | null;
  project: ProjectRow | null;
}

/**
 * Derive the entry's workspace/client/project (§4 rules):
 * - a project with a client sets client_id to that client;
 * - workspace_id always follows the project or client when either is set;
 * - a conflicting explicit value is rejected with 400.
 * For a PATCH, `current` supplies the values not being changed.
 */
export async function deriveScope(
  ctx: Ctx,
  input: RefsInput,
  current: Pick<EntryRow, 'workspace_id' | 'client_id' | 'project_id'> | null,
  settings: Settings,
): Promise<Scope> {
  let projectId = input.project_id !== undefined ? input.project_id : (current?.project_id ?? null);
  let clientId = input.client_id !== undefined ? input.client_id : (current?.client_id ?? null);

  // Changing only the client keeps the project if it belongs to that client.
  if (input.client_id !== undefined && input.project_id === undefined && projectId !== null) {
    const p = await requireProject(ctx, projectId);
    if (p.client_id !== input.client_id) projectId = null;
  }

  let project: ProjectRow | null = null;
  let client: ClientRow | null = null;
  if (projectId !== null) {
    project = await requireProject(ctx, projectId);
    if (input.client_id !== undefined && input.client_id !== project.client_id) {
      throw badRequest('client_conflict', 'client_id does not match the project’s client');
    }
    clientId = project.client_id;
  }
  if (clientId !== null) client = await requireClient(ctx, clientId);

  const derived = project?.workspace_id ?? client?.workspace_id ?? null;
  let workspaceId: number;
  if (derived !== null) {
    if (input.workspace_id != null && input.workspace_id !== derived) {
      throw badRequest('workspace_conflict', 'workspace_id does not match the client/project');
    }
    workspaceId = derived;
  } else {
    workspaceId =
      input.workspace_id ?? current?.workspace_id ?? (await activeWorkspaceId(ctx, settings));
  }
  const workspace = await requireWorkspace(ctx, workspaceId);
  return {
    workspace_id: workspaceId,
    client_id: clientId,
    project_id: projectId,
    workspace,
    client,
    project,
  };
}

/** The period lock covering an entry with this scope and start, if any (§4.1). */
export async function coveringLock(
  ctx: Ctx,
  scope: Pick<Scope, 'workspace_id' | 'client_id' | 'project_id'>,
  startAt: number,
): Promise<PeriodLockRow | null> {
  return ctx.db.first<PeriodLockRow>(
    `SELECT * FROM period_locks
      WHERE workspace_id = ?
        AND (client_id IS NULL OR client_id = ?)
        AND (project_id IS NULL OR project_id = ?)
        AND ? BETWEEN from_at AND to_at
      ORDER BY id LIMIT 1`,
    scope.workspace_id,
    scope.client_id,
    scope.project_id,
    startAt,
  );
}

function lockedPeriod(lock: PeriodLockRow): HttpError {
  return conflict('locked_period', 'This period is locked (invoiced)', {
    lock: {
      id: lock.id,
      from_date: lock.from_date,
      to_date: lock.to_date,
      from_at: lock.from_at,
      to_at: lock.to_at,
      note: lock.note,
    },
  });
}

async function assertNotLocked(ctx: Ctx, scope: Scope, startAt: number) {
  const lock = await coveringLock(ctx, scope, startAt);
  if (lock) throw lockedPeriod(lock);
}

function assertNotFuture(ctx: Ctx, ...times: (number | null | undefined)[]) {
  const limit = ctx.clock.now() + FUTURE_SLACK;
  for (const t of times) {
    if (t != null && t > limit)
      throw badRequest('in_future', 'Times may not be more than 5 minutes in the future');
  }
}

/** end > start, and at most 24 h unless forced (409 so the UI can ask, §6). */
function assertDuration(start: number, end: number, force: boolean | undefined) {
  if (end <= start) throw badRequest('end_before_start', 'End must be after start');
  if (end - start > MAX_DURATION && !force) {
    throw conflict('too_long', 'Entry is longer than 24 hours', { duration: end - start });
  }
}

export function toEntry(row: EntryRow, lookup: RateLookup): Entry {
  const r = resolveEntryRate(row, lookup);
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    client_id: row.client_id,
    project_id: row.project_id,
    description: row.description,
    start_at: row.start_at,
    end_at: row.end_at,
    billable: row.billable === 1,
    rate_locked_at: row.rate_locked_at,
    locked_rate: row.locked_rate,
    locked_currency: row.locked_currency,
    period_lock_id: row.period_lock_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    rate: r.rate,
    currency: r.currency,
    rate_source: r.source,
  };
}

/** Mark entries that overlap another entry in the list (running ones end "now"). */
export function flagOverlaps(entries: Entry[], now: number): Entry[] {
  const sorted = [...entries].sort((a, b) => a.start_at - b.start_at || a.id - b.id);
  let maxEnd = -Infinity;
  let maxIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    const end = e.end_at ?? now;
    if (e.start_at < maxEnd) {
      e.overlaps = true;
      sorted[maxIdx]!.overlaps = true;
    } else e.overlaps ??= false;
    if (end > maxEnd) {
      maxEnd = end;
      maxIdx = i;
    }
  }
  return entries;
}

export async function getEntry(ctx: Ctx, id: number): Promise<EntryRow> {
  const e = await ctx.db.first<EntryRow>('SELECT * FROM time_entries WHERE id = ?', id);
  if (!e) throw new HttpError(404, 'entry_not_found');
  return e;
}

export async function runningEntry(ctx: Ctx): Promise<EntryRow | null> {
  return ctx.db.first<EntryRow>('SELECT * FROM time_entries WHERE end_at IS NULL');
}

const INSERT_ENTRY = `INSERT INTO time_entries
  (workspace_id, client_id, project_id, description, start_at, end_at, billable, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`;

function defaultBillable(scope: Scope, settings: Settings): boolean {
  return resolveSetting('billable_default', {
    project: scope.project,
    workspace: scope.workspace,
    settings,
  });
}

// ── Manual entries ─────────────────────────────────────────────────────────

export async function createEntry(
  ctx: Ctx,
  input: RefsInput & {
    description: string;
    start_at: number;
    end_at: number;
    billable?: boolean;
    force?: boolean;
  },
): Promise<EntryRow> {
  const settings = await loadSettings(ctx);
  const scope = await deriveScope(ctx, input, null, settings);
  assertNotFuture(ctx, input.start_at, input.end_at);
  assertDuration(input.start_at, input.end_at, input.force);
  await assertNotLocked(ctx, scope, input.start_at);
  const now = ctx.clock.now();
  const billable = input.billable ?? defaultBillable(scope, settings);
  const [res] = await ctx.db.batch([
    {
      sql: INSERT_ENTRY,
      params: [
        scope.workspace_id,
        scope.client_id,
        scope.project_id,
        input.description,
        input.start_at,
        input.end_at,
        billable ? 1 : 0,
        now,
        now,
      ],
    },
  ]);
  const row = res!.rows[0] as unknown as EntryRow;
  ctx.events.emit({ type: 'entry.created', entry: { ...row } });
  return row;
}

export interface EntryUpdate extends RefsInput {
  description?: string;
  start_at?: number;
  end_at?: number;
  billable?: boolean;
  force?: boolean;
  rate_lock?: 'release' | 'keep';
}

/** PATCH semantics shared by /api/entries/:id and /api/timer (§4.1, §6). */
export async function updateEntry(
  ctx: Ctx,
  entry: EntryRow,
  input: EntryUpdate,
): Promise<EntryRow> {
  if (entry.period_lock_id !== null) {
    throw conflict('entry_locked', 'This entry is in a locked (invoiced) period');
  }
  if (entry.end_at === null && input.end_at !== undefined) {
    throw badRequest('use_timer_stop', 'Stop the running timer with POST /api/timer/stop');
  }
  const settings = await loadSettings(ctx);
  const refsChanged =
    input.workspace_id !== undefined ||
    input.client_id !== undefined ||
    input.project_id !== undefined;
  const scope = refsChanged ? await deriveScope(ctx, input, entry, settings) : null;
  const moved =
    scope !== null &&
    (scope.client_id !== entry.client_id || scope.project_id !== entry.project_id);

  // Moving a rate-locked entry: the frozen rate belongs to the old client/project.
  let releaseRate = false;
  if (moved && entry.rate_locked_at !== null) {
    if (!input.rate_lock) {
      throw conflict(
        'rate_lock_decision',
        'Entry is rate-locked: choose rate_lock "release" or "keep"',
        {
          locked_rate: entry.locked_rate,
          locked_currency: entry.locked_currency,
        },
      );
    }
    releaseRate = input.rate_lock === 'release';
  }

  const start = input.start_at ?? entry.start_at;
  const end = input.end_at ?? entry.end_at;
  assertNotFuture(ctx, input.start_at, input.end_at);
  if (end !== null) assertDuration(start, end, input.force);
  else if (start > ctx.clock.now() + FUTURE_SLACK) throw badRequest('in_future');

  const target = scope ?? {
    workspace_id: entry.workspace_id,
    client_id: entry.client_id,
    project_id: entry.project_id,
  };
  if (scope || input.start_at !== undefined) {
    const lock = await coveringLock(ctx, target, start);
    if (lock) throw lockedPeriod(lock);
  }

  const now = ctx.clock.now();
  const [res] = await ctx.db.batch([
    {
      sql: `UPDATE time_entries SET
              workspace_id = ?, client_id = ?, project_id = ?, description = ?,
              start_at = ?, end_at = ?, billable = ?, updated_at = ?
              ${releaseRate ? ', rate_locked_at = NULL, locked_rate = NULL, locked_currency = NULL' : ''}
            WHERE id = ? AND period_lock_id IS NULL RETURNING *`,
      params: [
        target.workspace_id,
        target.client_id,
        target.project_id,
        input.description ?? entry.description,
        start,
        end,
        input.billable === undefined ? entry.billable : input.billable ? 1 : 0,
        now,
        entry.id,
      ],
    },
  ]);
  const row = res!.rows[0] as unknown as EntryRow | undefined;
  if (!row) throw conflict('entry_locked', 'This entry was locked meanwhile');
  ctx.events.emit({ type: 'entry.updated', entry: { ...row } });
  return row;
}

export async function deleteEntry(ctx: Ctx, id: number): Promise<void> {
  const entry = await getEntry(ctx, id);
  if (entry.period_lock_id !== null)
    throw conflict('entry_locked', 'This entry is in a locked (invoiced) period');
  const r = await ctx.db.run(
    'DELETE FROM time_entries WHERE id = ? AND period_lock_id IS NULL',
    id,
  );
  if (r.changes !== 1) throw conflict('entry_locked');
  ctx.events.emit({ type: 'entry.deleted', id });
}

// ── Timer ──────────────────────────────────────────────────────────────────

export async function startTimer(
  ctx: Ctx,
  input: RefsInput & {
    description?: string;
    start_at?: number;
    billable?: boolean;
    force?: boolean;
  },
): Promise<{ started: EntryRow; stopped: EntryRow | null }> {
  const settings = await loadSettings(ctx);
  const scope = await deriveScope(ctx, input, null, settings);
  const start = input.start_at ?? ctx.clock.now();
  assertNotFuture(ctx, start);
  await assertNotLocked(ctx, scope, start);
  const now = ctx.clock.now();

  const stmts: Stmt[] = [];
  const running = await runningEntry(ctx);
  if (running) {
    if (start <= running.start_at) {
      throw conflict('start_before_running', 'The new timer would start before the running one');
    }
    if (start - running.start_at > MAX_DURATION && !input.force) {
      throw conflict('too_long', 'The running timer has run for more than 24 hours', {
        entry_id: running.id,
        duration: start - running.start_at,
      });
    }
    const lock = await coveringLock(ctx, running, running.start_at);
    if (lock) throw lockedPeriod(lock);
    // The old timer ends exactly where the new one starts: no overlap (§13).
    stmts.push({
      sql: 'UPDATE time_entries SET end_at = ?, updated_at = ? WHERE id = ? AND end_at IS NULL RETURNING *',
      params: [start, now, running.id],
    });
  }
  const billable = input.billable ?? defaultBillable(scope, settings);
  stmts.push({
    sql: INSERT_ENTRY,
    params: [
      scope.workspace_id,
      scope.client_id,
      scope.project_id,
      input.description ?? '',
      start,
      null,
      billable ? 1 : 0,
      now,
      now,
    ],
  });
  let results: BatchResult[];
  try {
    results = await ctx.db.batch(stmts);
  } catch (err) {
    // The one_running unique index rejected a concurrent start.
    if (/UNIQUE/i.test(String(err)))
      throw conflict('timer_running', 'Another timer was started meanwhile');
    throw err;
  }
  const stopped = running
    ? ((results[0]!.rows[0] as unknown as EntryRow | undefined) ?? null)
    : null;
  const started = results[results.length - 1]!.rows[0] as unknown as EntryRow;
  if (stopped) ctx.events.emit({ type: 'timer.stopped', entry: { ...stopped } });
  ctx.events.emit({ type: 'timer.started', entry: { ...started } });
  return { started, stopped };
}

export async function stopTimer(
  ctx: Ctx,
  input: { end_at?: number; force?: boolean; cut_at_lock?: boolean },
): Promise<{ entry: EntryRow | null; discarded: boolean }> {
  const running = await runningEntry(ctx);
  if (!running) throw conflict('no_timer', 'No timer is running');
  const end = input.end_at ?? ctx.clock.now();
  assertNotFuture(ctx, end);
  let start = running.start_at;

  // A period locked while the timer ran (§6 timer edge cases).
  const lock = await coveringLock(ctx, running, start);
  if (lock) {
    if (!input.cut_at_lock) throw lockedPeriod(lock);
    start = lock.to_at + 1;
    if (end <= start) {
      await ctx.db.run('DELETE FROM time_entries WHERE id = ? AND end_at IS NULL', running.id);
      ctx.events.emit({ type: 'entry.deleted', id: running.id });
      return { entry: null, discarded: true };
    }
  }
  assertDuration(start, end, input.force);
  const row = await ctx.db.first<EntryRow>(
    'UPDATE time_entries SET start_at = ?, end_at = ?, updated_at = ? WHERE id = ? AND end_at IS NULL RETURNING *',
    start,
    end,
    ctx.clock.now(),
    running.id,
  );
  if (!row) throw conflict('no_timer', 'The timer was stopped meanwhile');
  ctx.events.emit({ type: 'timer.stopped', entry: { ...row } });
  return { entry: row, discarded: false };
}

export async function discardTimer(ctx: Ctx): Promise<void> {
  const running = await runningEntry(ctx);
  if (!running) throw conflict('no_timer', 'No timer is running');
  await ctx.db.run('DELETE FROM time_entries WHERE id = ? AND end_at IS NULL', running.id);
  ctx.events.emit({ type: 'entry.deleted', id: running.id });
}
