// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reports (§7.1 #3): period presets, grouping, billable and invoicing
 * filters, hours / billable hours / amounts per currency, a per-day chart,
 * CSV export, and period locks.
 *
 * The filters live in the URL query (period, from, to, group, billable,
 * locked, decimal), so a report survives a trip to the invoice basis and back
 * and can be bookmarked. A preset is stored by name, so a bookmarked "last
 * month" stays relative; only a custom period stores its dates.
 */
import { useEffect, useState } from 'preact/hooks';
import { formatDecimalHours } from '../../core/time/format';
import { dateOf, isValidDate } from '../../core/time/tz';
import { formatCalendarDate, formatCalendarRange } from '../../core/time/format';
import { DayChart } from '../components/DayChart';
import { showError } from '../components/Toast';
import { get, qs } from '../lib/api';
import { hm, money } from '../lib/fmt';
import { t, translator } from '../lib/i18n';
import { lockPeriodFlow, unlockFlow, type Lock } from '../lib/locks';
import {
  matchPreset,
  PRESETS,
  presetRange,
  shiftRange,
  type Preset,
  type Range,
} from '../lib/periods';
import { query, setQuery } from '../lib/router';
import { useScreenKeys } from '../lib/shortcuts';
import {
  activeWorkspaceId,
  clientById,
  filterWorkspaceId,
  multiWorkspace,
  projectById,
  settings,
  workspaceById,
} from '../lib/store';

const GROUPS = ['workspace', 'client', 'project', 'day', 'week', 'month'] as const;
type GroupBy = (typeof GROUPS)[number];
const BILLABLE = ['all', 'true', 'false'];
const LOCKED = ['all', 'unlocked', 'locked'];

/** The current report's URL, so the invoice basis can link back to the same view. */
export const lastReports = { href: '/reports' };

interface Totals {
  seconds: number;
  billable_seconds: number;
  amounts: Record<string, number>;
  count: number;
}
interface Summary {
  groups: (Totals & {
    key: string;
    id: number | null;
    workspace_id: number | null;
    days?: Record<string, number>;
  })[];
  totals: Totals;
  days: { date: string; seconds: number }[];
  has_amounts: boolean;
}

export function ReportsScreen() {
  const tz = settings.value!.timezone;
  const today = dateOf(Math.floor(Date.now() / 1000), tz);
  const workspaceId = filterWorkspaceId.value;
  const showWorkspace = multiWorkspace.value && workspaceId === null;

  // Filters from the URL, each validated with a fallback to its default.
  const q = query.value;
  const named = q.get('period') as Preset | null;
  const preset: Preset = named && PRESETS.includes(named) ? named : 'thisWeek';
  const qFrom = q.get('from') ?? '';
  const qTo = q.get('to') ?? '';
  const range: Range =
    preset !== 'custom'
      ? presetRange(preset, today)
      : isValidDate(qFrom) && isValidDate(qTo) && qFrom <= qTo
        ? { from: qFrom, to: qTo }
        : presetRange('thisWeek', today);
  const qGroup = q.get('group') as GroupBy | null;
  // With "all workspaces" the default grouping is by workspace (§7.1 #3).
  const groupBy: GroupBy =
    qGroup && GROUPS.includes(qGroup) && (qGroup !== 'workspace' || showWorkspace)
      ? qGroup
      : showWorkspace
        ? 'workspace'
        : 'project';
  const billable = BILLABLE.includes(q.get('billable') ?? '') ? q.get('billable')! : 'all';
  const locked = LOCKED.includes(q.get('locked') ?? '') ? q.get('locked')! : 'all';
  const decimal = q.get('decimal') === '1';
  lastReports.href = `/reports${q.size ? `?${q}` : ''}`;

  /** Write changed filters to the URL; defaults are left out. */
  const update = (patch: Record<string, string | null>) =>
    setQuery({
      period: preset === 'thisWeek' ? null : preset,
      from: preset === 'custom' ? range.from : null,
      to: preset === 'custom' ? range.to : null,
      group: qGroup,
      billable: billable === 'all' ? null : billable,
      locked: locked === 'all' ? null : locked,
      decimal: decimal ? '1' : null,
      ...patch,
    });
  const setPreset = (p: Preset) =>
    update(
      p === 'custom'
        ? { period: 'custom', from: range.from, to: range.to }
        : { period: p === 'thisWeek' ? null : p, from: null, to: null },
    );
  const setRange = (r: Range) => update({ period: 'custom', from: r.from, to: r.to });
  /**
   * Previous/next period of the same size. Lands on a named preset whenever
   * it matches one, so ‹ then › from "last month" is "last month" again.
   */
  const step = (dir: 1 | -1) => {
    const r = shiftRange(range, dir);
    const p = matchPreset(r, today);
    if (p === 'custom') setRange(r);
    else setPreset(p);
  };

  useScreenKeys({
    ArrowLeft: () => step(-1),
    ArrowRight: () => step(1),
    g: () => document.getElementById('r-group')?.focus(),
  });

  const [data, setData] = useState<Summary | null>(null);
  const [locks, setLocks] = useState<Lock[]>([]);
  const params = { from: range.from, to: range.to, workspace_id: workspaceId, billable, locked };

  const reload = async () => {
    try {
      const [s, l] = await Promise.all([
        get<Summary>(`/reports/summary${qs({ ...params, group_by: groupBy })}`),
        get<Lock[]>(`/locks${qs({ workspace_id: workspaceId })}`),
      ]);
      setData(s);
      setLocks(l);
    } catch (err) {
      showError(err);
    }
  };
  useEffect(() => void reload(), [range.from, range.to, groupBy, billable, locked, workspaceId]);

  const loc = { locale: translator.value.locale };
  const label = (g: Summary['groups'][number]) => {
    switch (groupBy) {
      case 'workspace':
        return workspaceById.value.get(g.id!)?.name ?? '';
      case 'client':
        return g.id === null ? t('reports.noClient') : (clientById.value.get(g.id)?.name ?? '');
      case 'project': {
        if (g.id === null) return t('reports.noProject');
        const p = projectById.value.get(g.id);
        const c = p?.client_id ? clientById.value.get(p.client_id) : null;
        return p ? (c ? `${p.name} (${c.name})` : p.name) : '';
      }
      case 'day':
        return formatCalendarDate(g.key, loc);
      case 'week':
        return t('reports.week', { week: Number(g.key.slice(6)) }); // key: 2026-W37
      case 'month':
        return new Intl.DateTimeFormat(loc.locale, {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(Date.parse(`${g.key}-15T12:00:00Z`));
    }
  };
  const dur = (s: number) => (decimal ? formatDecimalHours(s, loc.locale) : hm(s));
  const currencies = data ? Object.keys(data.totals.amounts).sort() : [];
  const showAmounts = !!data?.has_amounts && currencies.length > 0;
  // Timesheet columns (one per day) for periods of at most a week, when the
  // rows are workspaces/clients/projects rather than time buckets.
  const dayCols =
    data && data.days.length <= 7 && ['workspace', 'client', 'project'].includes(groupBy)
      ? data.days.map((d) => d.date)
      : [];

  return (
    <div class="reports stack">
      <div class="page-head">
        <h1 tabIndex={-1}>{t('reports.title')}</h1>
        <div class="actions">
          <a class="btn plain" href={`/reports/invoice${qs({ from: range.from, to: range.to })}`}>
            {t('reports.invoiceBasis')}
          </a>
          <a class="btn plain" href={`/api/reports/export.csv${qs(params)}`} download>
            {t('reports.exportCsv')}
          </a>
          <button
            type="button"
            class="btn primary"
            onClick={async () =>
              (await lockPeriodFlow({
                workspace_id: workspaceId ?? activeWorkspaceId.value!,
                from_date: range.from,
                to_date: range.to,
              })) && reload()
            }
          >
            {t('reports.lockPeriod')}
          </button>
        </div>
      </div>

      <form class="filters" onSubmit={(e) => e.preventDefault()}>
        <div class="field">
          <label for="r-period">{t('reports.period')}</label>
          <select
            id="r-period"
            value={preset}
            onChange={(e) => setPreset(e.currentTarget.value as Preset)}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(`reports.${p}`)}
              </option>
            ))}
          </select>
        </div>
        {preset === 'custom' && (
          <>
            <div class="field">
              <label for="r-from">{t('reports.from')}</label>
              <input
                id="r-from"
                type="date"
                value={range.from}
                max={range.to}
                onChange={(e) => setRange({ ...range, from: e.currentTarget.value })}
              />
            </div>
            <div class="field">
              <label for="r-to">{t('reports.to')}</label>
              <input
                id="r-to"
                type="date"
                value={range.to}
                min={range.from}
                onChange={(e) => setRange({ ...range, to: e.currentTarget.value })}
              />
            </div>
          </>
        )}
        <div class="period-step">
          <button
            type="button"
            class="btn plain"
            aria-label={t('reports.prevPeriod')}
            aria-keyshortcuts="ArrowLeft"
            onClick={() => step(-1)}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <button
            type="button"
            class="btn plain"
            aria-label={t('reports.nextPeriod')}
            aria-keyshortcuts="ArrowRight"
            onClick={() => step(1)}
          >
            <span aria-hidden="true">›</span>
          </button>
          <span class="period-range" aria-live="polite">
            {formatCalendarRange(range.from, range.to, loc)}
          </span>
        </div>
        <div class="field">
          <label for="r-group">{t('reports.groupBy')}</label>
          <select
            id="r-group"
            aria-keyshortcuts="g"
            value={groupBy}
            onChange={(e) => update({ group: e.currentTarget.value })}
          >
            {GROUPS.filter((g) => g !== 'workspace' || showWorkspace).map((g) => (
              <option key={g} value={g}>
                {t(`reports.by${g[0]!.toUpperCase()}${g.slice(1)}`)}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="r-bill">{t('reports.billable')}</label>
          <select
            id="r-bill"
            value={billable}
            onChange={(e) =>
              update({ billable: e.currentTarget.value === 'all' ? null : e.currentTarget.value })
            }
          >
            <option value="all">{t('reports.billableAll')}</option>
            <option value="true">{t('reports.billableOnly')}</option>
            <option value="false">{t('reports.nonBillableOnly')}</option>
          </select>
        </div>
        <div class="field">
          <label for="r-locked">{t('reports.locked')}</label>
          <select
            id="r-locked"
            value={locked}
            onChange={(e) =>
              update({ locked: e.currentTarget.value === 'all' ? null : e.currentTarget.value })
            }
          >
            <option value="all">{t('reports.lockedAll')}</option>
            <option value="unlocked">{t('reports.unlockedOnly')}</option>
            <option value="locked">{t('reports.lockedOnly')}</option>
          </select>
        </div>
        <label class="check">
          <input
            type="checkbox"
            checked={decimal}
            onChange={(e) => update({ decimal: e.currentTarget.checked ? '1' : null })}
          />
          {t('reports.decimal')}
        </label>
      </form>

      {!data ? (
        <p>{t('app.loading')}</p>
      ) : data.totals.count === 0 ? (
        <p class="empty">{t('reports.noData')}</p>
      ) : (
        <>
          <DayChart days={data.days} />
          <div class="table-wrap">
            <table class={`report-table${dayCols.length ? ' timesheet' : ''}`}>
              <thead>
                <tr>
                  <th scope="col">
                    {t(`reports.by${groupBy[0]!.toUpperCase()}${groupBy.slice(1)}`)}
                  </th>
                  {dayCols.map((d) => (
                    <th scope="col" class="num" key={d}>
                      {formatCalendarDate(d, loc)}
                    </th>
                  ))}
                  <th scope="col" class="num">
                    {t('reports.hours')}
                  </th>
                  <th scope="col" class="num">
                    {t('reports.billableHours')}
                  </th>
                  {showAmounts &&
                    currencies.map((c) => (
                      <th scope="col" class="num" key={c}>
                        {t('reports.amount')} {c}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g) => (
                  <tr key={g.key}>
                    <th scope="row">{label(g)}</th>
                    {dayCols.map((d) => (
                      <td class="num" key={d}>
                        {g.days?.[d] ? dur(g.days[d]) : ''}
                      </td>
                    ))}
                    <td class="num">{dur(g.seconds)}</td>
                    <td class="num">{dur(g.billable_seconds)}</td>
                    {showAmounts &&
                      currencies.map((c) => (
                        <td class="num" key={c}>
                          {g.amounts[c] !== undefined ? money(g.amounts[c]!, c) : ''}
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{t('reports.total')}</th>
                  {data.days
                    .filter((d) => dayCols.includes(d.date))
                    .map((d) => (
                      <td class="num" key={d.date}>
                        {d.seconds ? dur(d.seconds) : ''}
                      </td>
                    ))}
                  <td class="num">{dur(data.totals.seconds)}</td>
                  <td class="num">{dur(data.totals.billable_seconds)}</td>
                  {showAmounts &&
                    currencies.map((c) => (
                      <td class="num" key={c}>
                        {money(data.totals.amounts[c]!, c)}
                      </td>
                    ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      <section class="stack" aria-labelledby="locks-title">
        <h2 id="locks-title">{t('locks.title')}</h2>
        {locks.length === 0 ? (
          <p class="empty">{t('locks.none')}</p>
        ) : (
          <ul class="cat-list">
            {locks.map((l) => (
              <li key={l.id} class="cat-row">
                <span class="flag" aria-hidden="true">
                  🔒
                </span>
                <span class="cat-name">
                  {formatCalendarDate(l.from_date, loc)} – {formatCalendarDate(l.to_date, loc)}
                  {l.note && <strong> {l.note}</strong>}
                  <span class="cat-meta">
                    {' '}
                    {l.client_id ? clientById.value.get(l.client_id)?.name : t('locks.scopeAll')}
                    {l.project_id ? ` / ${projectById.value.get(l.project_id)?.name}` : ''}
                    {showWorkspace ? ` (${workspaceById.value.get(l.workspace_id)?.name})` : ''}
                  </span>
                </span>
                <span class="cat-meta">{t('locks.entries', { count: l.entries })}</span>
                <button
                  type="button"
                  class="btn plain small"
                  onClick={async () => (await unlockFlow(l)) && reload()}
                >
                  {t('locks.unlock')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
