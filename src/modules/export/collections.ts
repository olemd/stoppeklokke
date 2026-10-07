// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Core export collections (§9.1). Columns are an explicit allow-list per
 * table, so a future sensitive column is never exported by accident. Not
 * exported at all: passkeys, sessions, recovery codes, push subscriptions,
 * notification log, API token hashes and webhook secrets.
 */
import { z } from 'zod';
import { badRequest } from '../../core/errors';
import type { Stmt } from '../../core/ports';
import type { Ctx, ExportCollection } from '../types';

type Col = 'int' | 'int?' | 'text' | 'text?';

interface TableSpec {
  name: string;
  order: number;
  key: string;
  columns: Record<string, Col>;
  /** Extra WHERE for export (e.g. internal settings keys). */
  exportWhere?: string;
}

/** Settings keys that belong to this instance, not to the data. */
export const INSTANCE_SETTINGS = ['webauthn_user_id', 'import_in_progress'];

const TABLES: TableSpec[] = [
  {
    name: 'settings',
    order: 0,
    key: 'key',
    columns: { key: 'text', value: 'text' },
    exportWhere: `key NOT IN (${INSTANCE_SETTINGS.map((k) => `'${k}'`).join(', ')})`,
  },
  {
    name: 'workspaces',
    order: 1,
    key: 'id',
    columns: {
      id: 'int',
      name: 'text',
      color: 'text',
      currency: 'text?',
      default_hourly_rate: 'int?',
      billable_default: 'int?',
      rounding_min: 'int?',
      rounding_mode: 'text?',
      daily_target_min: 'int?',
      alert_after_min: 'int?',
      tick_interval_min: 'int?',
      on_rate_change: 'text?',
      sort_order: 'int',
      archived: 'int',
      created_at: 'int',
      updated_at: 'int',
    },
  },
  {
    name: 'clients',
    order: 2,
    key: 'id',
    columns: {
      id: 'int',
      workspace_id: 'int',
      name: 'text',
      hourly_rate: 'int?',
      currency: 'text?',
      archived: 'int',
      created_at: 'int',
      updated_at: 'int',
    },
  },
  {
    name: 'projects',
    order: 3,
    key: 'id',
    columns: {
      id: 'int',
      workspace_id: 'int',
      client_id: 'int?',
      name: 'text',
      color: 'text',
      hourly_rate: 'int?',
      currency: 'text?',
      billable_default: 'int?',
      alert_after_min: 'int?',
      tick_interval_min: 'int?',
      archived: 'int',
      created_at: 'int',
      updated_at: 'int',
    },
  },
  {
    name: 'period_locks',
    order: 4,
    key: 'id',
    columns: {
      id: 'int',
      from_date: 'text',
      to_date: 'text',
      from_at: 'int',
      to_at: 'int',
      timezone: 'text',
      workspace_id: 'int',
      client_id: 'int?',
      project_id: 'int?',
      rounding_min: 'int',
      rounding_mode: 'text',
      note: 'text',
      locked_at: 'int',
    },
  },
  {
    name: 'time_entries',
    order: 5,
    key: 'id',
    columns: {
      id: 'int',
      workspace_id: 'int',
      client_id: 'int?',
      project_id: 'int?',
      description: 'text',
      start_at: 'int',
      end_at: 'int?',
      billable: 'int',
      rate_locked_at: 'int?',
      locked_rate: 'int?',
      locked_currency: 'text?',
      period_lock_id: 'int?',
      created_at: 'int',
      updated_at: 'int',
    },
  },
];

const zodFor = (c: Col) => {
  const base = c.startsWith('int') ? z.number().int() : z.string().max(10_000);
  return c.endsWith('?') ? base.nullable() : base;
};

function collection(t: TableSpec): ExportCollection {
  const cols = Object.keys(t.columns);
  const rowSchema = z.strictObject(Object.fromEntries(cols.map((c) => [c, zodFor(t.columns[c]!)])));
  const isInt = t.columns[t.key]!.startsWith('int');
  return {
    name: t.name,
    order: t.order,
    async page(ctx: Ctx, cursor: string | null, limit: number) {
      const where = [t.exportWhere, cursor !== null ? `${t.key} > ?` : null]
        .filter(Boolean)
        .join(' AND ');
      const params = cursor !== null ? [isInt ? Number(cursor) : cursor] : [];
      const rows = await ctx.db.all<Record<string, unknown>>(
        `SELECT ${cols.join(', ')} FROM ${t.name} ${where ? `WHERE ${where}` : ''} ORDER BY ${t.key} LIMIT ?`,
        ...params,
        limit + 1,
      );
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      return { rows: page, next: more ? String(page[page.length - 1]![t.key]) : null };
    },
    async import(ctx: Ctx, rows: unknown[]) {
      const stmts: Stmt[] = rows.map((r, i) => {
        const parsed = rowSchema.safeParse(r);
        if (!parsed.success) {
          throw badRequest(
            'invalid_row',
            `${t.name}[${i}]: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`,
          );
        }
        const row = parsed.data as Record<string, string | number | null>;
        if (t.name === 'settings' && INSTANCE_SETTINGS.includes(String(row.key))) {
          throw badRequest('invalid_row', `settings: "${row.key}" cannot be imported`);
        }
        const verb = t.name === 'settings' ? 'INSERT OR REPLACE' : 'INSERT';
        return {
          sql: `${verb} INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          params: cols.map((c) => row[c] ?? null),
        };
      });
      // One D1 batch per chunk: all rows or none.
      await ctx.db.batch(stmts);
      return stmts.length;
    },
    async count(ctx: Ctx) {
      const r = await ctx.db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${t.name} ${t.exportWhere ? `WHERE ${t.exportWhere}` : ''}`,
      );
      return r?.n ?? 0;
    },
    async wipe(ctx: Ctx) {
      if (t.name === 'settings') return; // settings are overwritten, never wiped
      await ctx.db.run(`DELETE FROM ${t.name}`);
    },
  };
}

export const coreCollections: ExportCollection[] = TABLES.map(collection);
