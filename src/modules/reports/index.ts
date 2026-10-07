// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reports (§9): summary with grouping, detailed list, CSV export, and the
 * invoice basis (§9.2). Hours are rounded per entry before summing; amounts
 * are per currency and never combined.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { badRequest } from '../../core/errors';
import {
  aggregate,
  invoiceBasis,
  type GroupBy,
  type ReportEntry,
} from '../../core/reports/aggregate';
import {
  BOM,
  csvFormatFor,
  csvLine,
  decimalHours,
  minorToDecimal,
  type CsvFormat,
} from '../../core/reports/csv';
import { formatHM } from '../../core/time/duration';
import { currencyDigits } from '../../core/time/format';
import { dateOf, zonedParts } from '../../core/time/tz';
import { catalogs } from '../../shared/i18n/catalogs.generated';
import { createTranslator } from '../../shared/i18n/translate';
import { Id } from '../../shared/schemas';
import { json } from '../http';
import type { AppEnv, Module } from '../types';
import { loadReport, ReportQuery, type ReportData } from './data';

const Totals = z.object({
  seconds: z.number(),
  billable_seconds: z.number(),
  amounts: z.record(z.string(), z.number()),
  count: z.number(),
});
const Summary = z.object({
  groups: z.array(
    Totals.extend({
      key: z.string(),
      id: z.number().nullable(),
      workspace_id: z.number().nullable(),
    }),
  ),
  totals: Totals,
  days: z.array(z.object({ date: z.string(), seconds: z.number() })),
  has_amounts: z.boolean(),
});
const DetailedRow = z.object({
  id: z.number(),
  workspace_id: z.number(),
  client_id: z.number().nullable(),
  project_id: z.number().nullable(),
  description: z.string(),
  start_at: z.number(),
  end_at: z.number(),
  billable: z.boolean(),
  seconds: z.number(),
  rate: z.number().nullable(),
  currency: z.string(),
  amount: z.number().nullable(),
  period_lock_id: z.number().nullable(),
  lock_note: z.string().nullable(),
});

const CsvQuery = ReportQuery.extend({
  sep: z.enum([',', ';', 'tab']).optional(),
  decimal: z.enum(['.', ',']).optional(),
  headers: z.enum(['localized', 'keys']).default('localized'),
});

const InvoiceQuery = z.object({
  workspace_id: Id,
  client_id: Id,
  from: z.string(),
  to: z.string(),
  locked: z.enum(['locked', 'unlocked', 'all']).default('unlocked'),
  detailed: z.enum(['0', '1']).default('0'),
});

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (epoch: number, tz: string) => {
  const p = zonedParts(epoch, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
};

function detailedRow(r: ReportEntry) {
  const e = r.entry;
  return {
    id: e.id,
    workspace_id: e.workspace_id,
    client_id: e.client_id,
    project_id: e.project_id,
    description: e.description,
    start_at: e.start_at,
    end_at: e.end_at!,
    billable: e.billable === 1,
    seconds: r.seconds,
    rate: r.rate,
    currency: r.currency,
    amount: r.amount,
    period_lock_id: e.period_lock_id,
    lock_note: r.lock?.note ?? null,
  };
}

function csvFormat(q: { sep?: string; decimal?: string }, locale: string): CsvFormat {
  const f = csvFormatFor(locale);
  return {
    sep: q.sep === 'tab' ? '\t' : ((q.sep as CsvFormat['sep']) ?? f.sep),
    decimal: (q.decimal as CsvFormat['decimal']) ?? f.decimal,
  };
}

function csvResponse(c: Context<AppEnv>, filename: string, body: string) {
  return c.body(BOM + body, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
  });
}

const CSV_COLUMNS = [
  'date',
  'start',
  'end',
  'duration',
  'workspace',
  'hours',
  'client',
  'project',
  'description',
  'billable',
  'rate',
  'currency',
  'amount',
  'locked',
  'lock_note',
] as const;

function detailedCsv(data: ReportData, f: CsvFormat, keys: boolean): string {
  const { lookup, priced, tz } = data;
  const t = createTranslator(lookup.settings.locale, catalogs).t;
  const multi = [...lookup.workspaces.values()].filter((w) => !w.archived).length > 1;
  // Single workspace → no workspace column anywhere (§4.4).
  const columns = CSV_COLUMNS.filter((c) => c !== 'workspace' || multi);
  let out = csvLine(
    columns.map((c) => (keys ? c : t(`csv.${c}`))),
    f,
  );
  const yes = keys ? 'yes' : t('common.yes');
  const no = keys ? 'no' : t('common.no');
  for (const r of priced) {
    const e = r.entry;
    const project = e.project_id !== null ? lookup.projects.get(e.project_id) : null;
    const client = e.client_id !== null ? lookup.clients.get(e.client_id) : null;
    const digits = currencyDigits(r.currency);
    const row: Record<(typeof CSV_COLUMNS)[number], string | number | null> = {
      date: dateOf(e.start_at, tz),
      start: hhmm(e.start_at, tz),
      end: hhmm(e.end_at!, tz),
      duration: formatHM(r.seconds),
      workspace: lookup.workspaces.get(e.workspace_id)?.name ?? '',
      hours: decimalHours(r.seconds),
      client: client?.name ?? '',
      project: project?.name ?? '',
      description: e.description,
      billable: e.billable ? yes : no,
      rate: r.rate === null ? '' : minorToDecimal(r.rate, digits),
      currency: r.rate === null ? '' : r.currency,
      amount: r.amount === null ? '' : minorToDecimal(r.amount, digits),
      locked: e.period_lock_id !== null ? yes : no,
      lock_note: r.lock?.note ?? '',
    };
    out += csvLine(
      columns.map((c) => row[c]),
      f,
    );
  }
  return out;
}

export const reportsModule: Module = {
  name: 'reports',
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/summary',
        tags: ['reports'],
        request: {
          query: ReportQuery.extend({
            group_by: z
              .enum(['workspace', 'client', 'project', 'day', 'week', 'month'])
              .default('project'),
          }),
        },
        responses: { 200: json(Summary) },
      }),
      async (c) => {
        const q = c.req.valid('query');
        const data = await loadReport(c.env.ctx, q);
        return c.json(
          aggregate(data.priced, q.group_by as GroupBy, { from: q.from, to: q.to, tz: data.tz }),
          200,
        );
      },
    );

    app.openapi(
      createRoute({
        method: 'get',
        path: '/detailed',
        tags: ['reports'],
        request: { query: ReportQuery },
        responses: {
          200: json(z.object({ entries: z.array(DetailedRow), has_amounts: z.boolean() })),
        },
      }),
      async (c) => {
        const data = await loadReport(c.env.ctx, c.req.valid('query'));
        return c.json(
          {
            entries: data.priced.map(detailedRow),
            has_amounts: data.priced.some((p) => p.rate !== null),
          },
          200,
        );
      },
    );

    // Plain route (not JSON): CSV body.
    app.get('/export.csv', async (c) => {
      const parsed = CsvQuery.safeParse(c.req.query());
      if (!parsed.success) throw badRequest('validation', parsed.error.issues[0]?.message);
      const q = parsed.data;
      const data = await loadReport(c.env.ctx, q);
      const f = csvFormat(q, data.lookup.settings.locale);
      return csvResponse(
        c,
        `stoppeklokke-${q.from}-${q.to}.csv`,
        detailedCsv(data, f, q.headers === 'keys'),
      );
    });

    app.openapi(
      createRoute({
        method: 'get',
        path: '/invoice',
        tags: ['reports'],
        request: { query: InvoiceQuery },
        responses: { 200: json(z.record(z.string(), z.unknown())) },
      }),
      async (c) => {
        const q = c.req.valid('query');
        const data = await loadReport(c.env.ctx, { ...q, billable: 'all', project_id: undefined });
        const basis = invoiceBasis(data.priced);
        const strip = (l: (typeof basis.non_billable)[number]) => ({
          ...l,
          entries: q.detailed === '1' ? l.entries.map(detailedRow) : undefined,
        });
        return c.json(
          {
            projects: basis.projects.map((p) => ({ ...p, lines: p.lines.map(strip) })),
            non_billable: basis.non_billable.map(strip),
            totals: basis.totals,
            has_amounts: data.priced.some((p) => p.rate !== null),
          },
          200,
        );
      },
    );

    app.get('/invoice.csv', async (c) => {
      const parsed = InvoiceQuery.extend({
        sep: z.enum([',', ';', 'tab']).optional(),
        decimal: z.enum(['.', ',']).optional(),
        headers: z.enum(['localized', 'keys']).default('localized'),
      }).safeParse(c.req.query());
      if (!parsed.success) throw badRequest('validation', parsed.error.issues[0]?.message);
      const q = parsed.data;
      const data = await loadReport(c.env.ctx, { ...q, billable: 'all', project_id: undefined });
      if (q.detailed === '1') {
        const f = csvFormat(q, data.lookup.settings.locale);
        return csvResponse(
          c,
          `invoice-basis-${q.from}-${q.to}.csv`,
          detailedCsv(data, f, q.headers === 'keys'),
        );
      }
      const { lookup } = data;
      const t = createTranslator(lookup.settings.locale, catalogs).t;
      const f = csvFormat(q, lookup.settings.locale);
      const keys = q.headers === 'keys';
      const cols = [
        'project',
        'description',
        'hours',
        'rate',
        'currency',
        'amount',
        'billable',
      ] as const;
      let out = csvLine(
        cols.map((k) => (keys ? k : t(`csv.${k}`))),
        f,
      );
      const basis = invoiceBasis(data.priced);
      const line = (l: (typeof basis.non_billable)[number], billable: boolean) => {
        const digits = currencyDigits(l.currency);
        out += csvLine(
          [
            l.project_id !== null ? (lookup.projects.get(l.project_id)?.name ?? '') : '',
            l.description,
            decimalHours(l.seconds),
            l.rate === null ? '' : minorToDecimal(l.rate, digits),
            l.rate === null ? '' : l.currency,
            l.amount === null ? '' : minorToDecimal(l.amount, digits),
            billable ? (keys ? 'yes' : t('common.yes')) : keys ? 'no' : t('common.no'),
          ],
          f,
        );
      };
      for (const p of basis.projects) for (const l of p.lines) line(l, true);
      for (const l of basis.non_billable) line(l, false);
      return csvResponse(c, `invoice-basis-${q.from}-${q.to}.csv`, out);
    });
  },
};
