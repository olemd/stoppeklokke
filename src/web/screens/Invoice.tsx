// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Invoice basis (§9.2): the source for an invoice written elsewhere.
 * Client → project → description lines with rounded hours, rate and amount;
 * non-billable time listed separately; CSV and a clean print view; then
 * "Lock this period" with the invoice number.
 */
import { useEffect, useState } from 'preact/hooks';
import { formatDecimalHours } from '../../core/time/format';
import { dateOf } from '../../core/time/tz';
import { showError } from '../components/Toast';
import { get, qs } from '../lib/api';
import { date, money, rate as fmtRate, time } from '../lib/fmt';
import { t, translator } from '../lib/i18n';
import { lockPeriodFlow } from '../lib/locks';
import { presetRange } from '../lib/periods';
import { query } from '../lib/router';
import {
  activeWorkspaceId,
  activeWorkspaces,
  clients,
  multiWorkspace,
  projectById,
  settings,
} from '../lib/store';

interface Line {
  project_id: number | null;
  description: string;
  seconds: number;
  rate: number | null;
  currency: string;
  amount: number | null;
  entries?: {
    id: number;
    start_at: number;
    end_at: number;
    seconds: number;
    description: string;
  }[];
}
interface Basis {
  projects: {
    project_id: number | null;
    lines: Line[];
    seconds: number;
    amounts: Record<string, number>;
  }[];
  non_billable: Line[];
  totals: { seconds: number; amounts: Record<string, number>; non_billable_seconds: number };
  has_amounts: boolean;
}

export function InvoiceScreen() {
  const tz = settings.value!.timezone;
  const today = dateOf(Math.floor(Date.now() / 1000), tz);
  const last = presetRange('lastMonth', today);
  const [from, setFrom] = useState(query.value.get('from') ?? last.from);
  const [to, setTo] = useState(query.value.get('to') ?? last.to);
  const [wsChoice, setWorkspaceId] = useState<number | null>(null);
  const workspaceId = wsChoice ?? activeWorkspaceId.value!;
  const [clientId, setClientId] = useState<number | null>(null);
  const [unlockedOnly, setUnlockedOnly] = useState(true);
  const [detailed, setDetailed] = useState(false);
  const [basis, setBasis] = useState<Basis | null>(null);
  const locale = translator.value.locale;
  const h = (s: number) => formatDecimalHours(s, locale);
  const wsClients = clients.value.filter((c) => c.workspace_id === workspaceId && !c.archived);
  const params = {
    workspace_id: workspaceId,
    client_id: clientId,
    from,
    to,
    locked: unlockedOnly ? 'unlocked' : 'all',
    detailed: detailed ? 1 : 0,
  };

  const reload = async () => {
    if (!clientId) return setBasis(null);
    try {
      setBasis(await get<Basis>(`/reports/invoice${qs(params)}`));
    } catch (err) {
      showError(err);
    }
  };
  useEffect(() => void reload(), [workspaceId, clientId, from, to, unlockedOnly, detailed]);

  const lineRows = (l: Line, i: number) => [
    <tr key={`l${i}`}>
      <td>{l.description || t('timer.untitled')}</td>
      <td class="num">{h(l.seconds)}</td>
      {basis!.has_amounts && (
        <td class="num">{l.rate === null ? t('invoice.noRate') : fmtRate(l.rate, l.currency)}</td>
      )}
      {basis!.has_amounts && (
        <td class="num">{l.amount === null ? '' : money(l.amount, l.currency)}</td>
      )}
    </tr>,
    ...(l.entries ?? []).map((e) => (
      <tr key={`e${e.id}`} class="detail-row">
        <td>
          {date(e.start_at)} {time(e.start_at)}–{time(e.end_at)}
        </td>
        <td class="num">{h(e.seconds)}</td>
        {basis!.has_amounts && <td />}
        {basis!.has_amounts && <td />}
      </tr>
    )),
  ];

  const head = (
    <thead>
      <tr>
        <th scope="col">{t('invoice.description')}</th>
        <th scope="col" class="num">
          {t('invoice.hours')}
        </th>
        {basis?.has_amounts && (
          <th scope="col" class="num">
            {t('invoice.rate')}
          </th>
        )}
        {basis?.has_amounts && (
          <th scope="col" class="num">
            {t('invoice.amount')}
          </th>
        )}
      </tr>
    </thead>
  );
  const client = clients.value.find((c) => c.id === clientId);

  return (
    <div class="invoice stack">
      <div class="page-head">
        <h1 tabIndex={-1}>
          {t('invoice.title')}
          {client && <span class="print-only">: {client.name}</span>}
        </h1>
        {basis && clientId && (
          <div class="actions no-print">
            <a class="btn plain" href={`/api/reports/invoice.csv${qs(params)}`} download>
              {t('reports.exportCsv')}
            </a>
            <button type="button" class="btn plain" onClick={() => print()}>
              {t('invoice.print')}
            </button>
            <button
              type="button"
              class="btn primary"
              onClick={async () =>
                (await lockPeriodFlow({
                  workspace_id: workspaceId,
                  client_id: clientId,
                  from_date: from,
                  to_date: to,
                })) && reload()
              }
            >
              {t('invoice.lockThis')}
            </button>
          </div>
        )}
      </div>
      <p class="no-print">{t('invoice.intro')}</p>
      <form class="filters no-print" onSubmit={(e) => e.preventDefault()}>
        {multiWorkspace.value && (
          <div class="field">
            <label for="i-ws">{t('nav.workspace')}</label>
            <select
              id="i-ws"
              value={workspaceId}
              onChange={(e) => {
                setWorkspaceId(Number(e.currentTarget.value));
                setClientId(null);
              }}
            >
              {activeWorkspaces.value.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div class="field">
          <label for="i-client">{t('invoice.client')}</label>
          <select
            id="i-client"
            value={clientId ?? ''}
            required
            onChange={(e) => setClientId(Number(e.currentTarget.value) || null)}
          >
            <option value="">{t('invoice.chooseClient')}</option>
            {wsClients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="i-from">{t('reports.from')}</label>
          <input
            id="i-from"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="i-to">{t('reports.to')}</label>
          <input
            id="i-to"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.currentTarget.value)}
          />
        </div>
        <label class="check">
          <input
            type="checkbox"
            checked={unlockedOnly}
            onChange={(e) => setUnlockedOnly(e.currentTarget.checked)}
          />
          {t('invoice.unlockedOnly')}
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={detailed}
            onChange={(e) => setDetailed(e.currentTarget.checked)}
          />
          {t('invoice.detailed')}
        </label>
      </form>
      <p class="print-only">
        {from} – {to}
      </p>

      {basis &&
        (basis.projects.length === 0 && basis.non_billable.length === 0 ? (
          <p class="empty">{t('invoice.empty')}</p>
        ) : (
          <>
            {basis.projects.map((p) => (
              <section
                key={String(p.project_id)}
                class="stack"
                aria-labelledby={`ip-${p.project_id}`}
              >
                <h2 id={`ip-${p.project_id}`}>
                  {p.project_id !== null
                    ? projectById.value.get(p.project_id)?.name
                    : t('reports.noProject')}
                </h2>
                <div class="table-wrap">
                  <table class="report-table">
                    {head}
                    <tbody>{p.lines.flatMap(lineRows)}</tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">{t('invoice.subtotal')}</th>
                        <td class="num">{h(p.seconds)}</td>
                        {basis.has_amounts && <td />}
                        {basis.has_amounts && (
                          <td class="num">
                            {Object.entries(p.amounts)
                              .map(([c, v]) => money(v, c))
                              .join(' + ')}
                          </td>
                        )}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>
            ))}
            <section class="panel invoice-total" aria-label={t('invoice.total')}>
              <p>
                <strong>{t('invoice.total')}:</strong> {h(basis.totals.seconds)}{' '}
                {t('invoice.hours').toLowerCase()}
              </p>
              {Object.entries(basis.totals.amounts).map(([c, v]) => (
                <p key={c} class="total-amount">
                  {money(v, c)}
                </p>
              ))}
            </section>
            {basis.non_billable.length > 0 && (
              <section class="stack" aria-labelledby="ip-nb">
                <h2 id="ip-nb">{t('invoice.nonBillable')}</h2>
                <div class="table-wrap">
                  <table class="report-table muted">
                    {head}
                    <tbody>{basis.non_billable.flatMap(lineRows)}</tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        ))}
    </div>
  );
}
