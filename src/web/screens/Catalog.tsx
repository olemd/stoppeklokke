// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Workspaces, clients and projects (§7.1 #4). Rates show the inherited value
 * as a placeholder; clearing a field means "inherit", 0 is an explicit rate.
 * The workspaces section only appears with more than one workspace.
 */
import { useState } from 'preact/hooks';
import { resolveRate, type RateSource } from '../../core/rates/resolve';
import type { Client, Project, Workspace } from '../../shared/schemas';
import { showError, toast } from '../components/Toast';
import { patch, post } from '../lib/api';
import { moneyInput, parseMoney, rate as fmtRate } from '../lib/fmt';
import { withConflicts } from '../lib/flows';
import { t } from '../lib/i18n';
import {
  activeWorkspaceId,
  activeWorkspaces,
  clients,
  loadCatalog,
  multiWorkspace,
  projects,
  settings,
  workspaces,
} from '../lib/store';

const SOURCE_KEY: Record<RateSource, string> = {
  project: 'catalog.sourceProject',
  client: 'catalog.sourceClient',
  workspace: 'catalog.sourceWorkspace',
  default: 'catalog.sourceDefault',
  locked: 'catalog.sourceDefault',
};

function inheritedPlaceholder(parent: { client?: Client | null; workspace?: Workspace | null }) {
  const s = settings.value!;
  const r = resolveRate(null, null, parent.client ?? null, parent.workspace ?? null, s);
  return {
    currency: r.currency,
    text:
      r.rate === null
        ? t('catalog.rateNone')
        : t('catalog.rateInherited', {
            source: t(SOURCE_KEY[r.source!]),
            rate: fmtRate(r.rate, r.currency),
          }),
  };
}

async function save<T>(fn: (extra: Record<string, unknown>) => Promise<T>) {
  try {
    const r = await withConflicts(fn);
    if (r) {
      const res = (r as { rate_change_result?: { locked: number } }).rate_change_result;
      toast(res?.locked ? t('rateChange.locked', { count: res.locked }) : t('common.saved'));
      await loadCatalog();
    }
    return r;
  } catch (err) {
    showError(err);
    return null;
  }
}

/** Rate + currency inputs with the inherited value as placeholder. */
function RateFields({
  id,
  rate,
  currency,
  parent,
  onChange,
}: {
  id: string;
  rate: number | null;
  currency: string | null;
  parent: { client?: Client | null; workspace?: Workspace | null };
  onChange: (v: { rate: number | null; currency: string | null; valid: boolean }) => void;
}) {
  const inh = inheritedPlaceholder(parent);
  const cur = currency ?? inh.currency;
  const [text, setText] = useState(moneyInput(rate, cur));
  const [curText, setCurText] = useState(currency ?? '');
  const parsed = text.trim() === '' ? null : parseMoney(text, cur);
  const invalid = text.trim() !== '' && parsed === null;
  return (
    <div class="grid-2">
      <div class="field">
        <label for={`${id}-rate`}>{t('catalog.rate')}</label>
        <input
          id={`${id}-rate`}
          inputMode="decimal"
          placeholder={inh.text}
          value={text}
          aria-invalid={invalid}
          aria-describedby={`${id}-rate-hint`}
          onInput={(e) => {
            const v = e.currentTarget.value;
            setText(v);
            const p = v.trim() === '' ? null : parseMoney(v, cur);
            onChange({ rate: p, currency: curText || null, valid: v.trim() === '' || p !== null });
          }}
        />
        <span id={`${id}-rate-hint`} class="hint">
          {invalid ? t('common.invalidAmount') : inh.text}
        </span>
      </div>
      <div class="field">
        <label for={`${id}-cur`}>{t('catalog.currency')}</label>
        <input
          id={`${id}-cur`}
          maxLength={3}
          autoCapitalize="characters"
          placeholder={t('catalog.currencyInherited', { currency: inh.currency })}
          value={curText}
          onInput={(e) => {
            const v = e.currentTarget.value.toUpperCase();
            setCurText(v);
            onChange({ rate: parsed, currency: v || null, valid: !invalid });
          }}
        />
      </div>
    </div>
  );
}

function ClientEditor({
  client,
  defaultWorkspaceId,
  onDone,
}: {
  client?: Client;
  defaultWorkspaceId?: number;
  onDone: () => void;
}) {
  const [name, setName] = useState(client?.name ?? '');
  const [workspaceId, setWorkspaceId] = useState(
    client?.workspace_id ?? defaultWorkspaceId ?? activeWorkspaceId.value!,
  );
  const [money, setMoney] = useState({
    rate: client?.hourly_rate ?? null,
    currency: client?.currency ?? null,
    valid: true,
  });
  const workspace = workspaces.value.find((w) => w.id === workspaceId) ?? null;
  const prefix = client ? `c${client.id}` : 'cnew';
  return (
    <form
      class="panel stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!money.valid) return;
        const body = { name, hourly_rate: money.rate, currency: money.currency };
        const ok = client
          ? await save((x) => patch(`/clients/${client.id}`, { ...body, ...x }))
          : await save(() => post('/clients', { ...body, workspace_id: workspaceId }));
        if (ok) onDone();
      }}
    >
      <div class="field">
        <label for={`${prefix}-name`}>{t('common.name')}</label>
        <input
          id={`${prefix}-name`}
          required
          maxLength={200}
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </div>
      {multiWorkspace.value && (
        <div class="field">
          <label for={`${prefix}-ws`}>{client ? t('catalog.moveTo') : t('nav.workspace')}</label>
          <select
            id={`${prefix}-ws`}
            value={workspaceId}
            onChange={async (e) => {
              const target = Number(e.currentTarget.value);
              setWorkspaceId(target);
              if (client && target !== client.workspace_id) {
                const r = await save(() =>
                  post(`/clients/${client.id}/move`, { workspace_id: target }),
                );
                if (r) toast(t('catalog.moved'));
              }
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
      <RateFields
        id={prefix}
        rate={money.rate}
        currency={money.currency}
        parent={{ workspace }}
        onChange={setMoney}
      />
      <div class="actions">
        {client && (
          <button
            type="button"
            class="btn plain"
            onClick={async () =>
              (await save(() => patch(`/clients/${client.id}`, { archived: !client.archived }))) &&
              onDone()
            }
          >
            {client.archived ? t('common.unarchive') : t('common.archive')}
          </button>
        )}
        <span class="spacer" />
        <button type="button" class="btn plain" onClick={onDone}>
          {t('common.cancel')}
        </button>
        <button type="submit" class="btn primary">
          {t('common.save')}
        </button>
      </div>
    </form>
  );
}

function ProjectEditor({
  project,
  clientId,
  workspaceId,
  onDone,
}: {
  project?: Project;
  clientId: number | null;
  workspaceId: number;
  onDone: () => void;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState(project?.color ?? '#4f7cff');
  const [client, setClient] = useState<number | null>(project ? project.client_id : clientId);
  const [billable, setBillable] = useState<'' | 'true' | 'false'>(
    project?.billable_default === null || project === undefined
      ? ''
      : project.billable_default
        ? 'true'
        : 'false',
  );
  const [money, setMoney] = useState({
    rate: project?.hourly_rate ?? null,
    currency: project?.currency ?? null,
    valid: true,
  });
  const [alert, setAlert] = useState(project?.alert_after_min?.toString() ?? '');
  const [tick, setTick] = useState(project?.tick_interval_min?.toString() ?? '');
  const ws = project?.workspace_id ?? workspaceId;
  const parentClient = clients.value.find((c) => c.id === client) ?? null;
  const prefix = project ? `p${project.id}` : `pnew${clientId ?? 'i'}`;
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  return (
    <form
      class="panel stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!money.valid) return;
        const body = {
          name,
          color,
          client_id: client,
          hourly_rate: money.rate,
          currency: money.currency,
          billable_default: billable === '' ? null : billable === 'true',
          alert_after_min: num(alert),
          tick_interval_min: num(tick),
        };
        const ok = project
          ? await save((x) => patch(`/projects/${project.id}`, { ...body, ...x }))
          : await save(() => post('/projects', { ...body, workspace_id: ws }));
        if (ok) onDone();
      }}
    >
      <div class="grid-2">
        <div class="field">
          <label for={`${prefix}-name`}>{t('common.name')}</label>
          <input
            id={`${prefix}-name`}
            required
            maxLength={200}
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for={`${prefix}-color`}>{t('common.color')}</label>
          <input
            id={`${prefix}-color`}
            type="color"
            value={color}
            onInput={(e) => setColor(e.currentTarget.value)}
          />
        </div>
      </div>
      <div class="field">
        <label for={`${prefix}-client`}>{t('catalog.client')}</label>
        <select
          id={`${prefix}-client`}
          value={client ?? ''}
          onChange={(e) => setClient(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
        >
          <option value="">{t('catalog.internal')}</option>
          {clients.value
            .filter((c) => c.workspace_id === ws && (!c.archived || c.id === client))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </div>
      <RateFields
        id={prefix}
        rate={money.rate}
        currency={money.currency}
        parent={{ client: parentClient, workspace: workspaces.value.find((w) => w.id === ws) }}
        onChange={setMoney}
      />
      <details>
        <summary>{t('settings.notifications')}</summary>
        <div class="grid-3">
          <div class="field">
            <label for={`${prefix}-bill`}>{t('catalog.billableDefault')}</label>
            <select
              id={`${prefix}-bill`}
              value={billable}
              onChange={(e) => setBillable(e.currentTarget.value as never)}
            >
              <option value="">{t('common.inherit')}</option>
              <option value="true">{t('common.yes')}</option>
              <option value="false">{t('common.no')}</option>
            </select>
          </div>
          <div class="field">
            <label for={`${prefix}-alert`}>{t('catalog.alertAfter')}</label>
            <input
              id={`${prefix}-alert`}
              inputMode="numeric"
              placeholder={t('common.inherit')}
              value={alert}
              onInput={(e) => setAlert(e.currentTarget.value)}
            />
          </div>
          <div class="field">
            <label for={`${prefix}-tick`}>{t('catalog.tickInterval')}</label>
            <input
              id={`${prefix}-tick`}
              inputMode="numeric"
              placeholder={t('common.inherit')}
              value={tick}
              onInput={(e) => setTick(e.currentTarget.value)}
            />
          </div>
        </div>
      </details>
      <div class="actions">
        {project && (
          <button
            type="button"
            class="btn plain"
            onClick={async () =>
              (await save(() =>
                patch(`/projects/${project.id}`, { archived: !project.archived }),
              )) && onDone()
            }
          >
            {project.archived ? t('common.unarchive') : t('common.archive')}
          </button>
        )}
        <span class="spacer" />
        <button type="button" class="btn plain" onClick={onDone}>
          {t('common.cancel')}
        </button>
        <button type="submit" class="btn primary">
          {t('common.save')}
        </button>
      </div>
    </form>
  );
}

function WorkspaceEditor({ workspace, onDone }: { workspace?: Workspace; onDone: () => void }) {
  const [name, setName] = useState(workspace?.name ?? '');
  const [money, setMoney] = useState({
    rate: workspace?.default_hourly_rate ?? null,
    currency: workspace?.currency ?? null,
    valid: true,
  });
  const [billable, setBillable] = useState<'' | 'true' | 'false'>(
    workspace?.billable_default == null ? '' : workspace.billable_default ? 'true' : 'false',
  );
  const [target, setTarget] = useState(workspace?.daily_target_min?.toString() ?? '');
  const prefix = workspace ? `w${workspace.id}` : 'wnew';
  return (
    <form
      class="panel stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!money.valid) return;
        const body = {
          name,
          default_hourly_rate: money.rate,
          currency: money.currency,
          billable_default: billable === '' ? null : billable === 'true',
          daily_target_min: target.trim() === '' ? null : Number(target),
        };
        const ok = workspace
          ? await save((x) => patch(`/workspaces/${workspace.id}`, { ...body, ...x }))
          : await save(() => post('/workspaces', body));
        if (ok) onDone();
      }}
    >
      <div class="field">
        <label for={`${prefix}-name`}>{t('common.name')}</label>
        <input
          id={`${prefix}-name`}
          required
          maxLength={200}
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </div>
      <RateFields
        id={prefix}
        rate={money.rate}
        currency={money.currency}
        parent={{}}
        onChange={setMoney}
      />
      <div class="grid-2">
        <div class="field">
          <label for={`${prefix}-bill`}>{t('catalog.billableDefault')}</label>
          <select
            id={`${prefix}-bill`}
            value={billable}
            onChange={(e) => setBillable(e.currentTarget.value as never)}
          >
            <option value="">{t('common.inherit')}</option>
            <option value="true">{t('common.yes')}</option>
            <option value="false">{t('common.no')}</option>
          </select>
        </div>
        <div class="field">
          <label for={`${prefix}-target`}>{t('catalog.dailyTarget')}</label>
          <input
            id={`${prefix}-target`}
            inputMode="numeric"
            placeholder={t('common.inherit')}
            value={target}
            onInput={(e) => setTarget(e.currentTarget.value)}
          />
        </div>
      </div>
      <div class="actions">
        {workspace && activeWorkspaces.value.length > 1 && (
          <button
            type="button"
            class="btn plain"
            onClick={async () =>
              (await save(() =>
                patch(`/workspaces/${workspace.id}`, { archived: !workspace.archived }),
              )) && onDone()
            }
          >
            {workspace.archived ? t('common.unarchive') : t('common.archive')}
          </button>
        )}
        <span class="spacer" />
        <button type="button" class="btn plain" onClick={onDone}>
          {t('common.cancel')}
        </button>
        <button type="submit" class="btn primary">
          {t('common.save')}
        </button>
      </div>
    </form>
  );
}

export function CatalogScreen() {
  const [editing, setEditing] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const done = () => setEditing(null);
  const visible = <T extends { archived: boolean }>(xs: T[]) =>
    xs.filter((x) => showArchived || !x.archived);
  const wsList = multiWorkspace.value ? visible(workspaces.value) : workspaces.value.slice(0, 1);

  const projectRow = (p: Project) =>
    editing === `p${p.id}` ? (
      <li key={p.id}>
        <ProjectEditor
          project={p}
          clientId={p.client_id}
          workspaceId={p.workspace_id}
          onDone={done}
        />
      </li>
    ) : (
      <li key={p.id} class="cat-row">
        <span class="swatch" style={{ backgroundColor: p.color }} aria-hidden="true" />
        <span class="cat-name">{p.name}</span>
        {p.hourly_rate !== null && (
          <span class="cat-meta">
            {fmtRate(p.hourly_rate, p.currency ?? settings.value!.currency)}
          </span>
        )}
        {p.archived && <span class="tag muted">{t('common.archived')}</span>}
        <button
          type="button"
          class="btn plain small"
          aria-label={`${t('common.edit')}: ${p.name}`}
          onClick={() => setEditing(`p${p.id}`)}
        >
          {t('common.edit')}
        </button>
      </li>
    );

  return (
    <div class="catalog stack">
      <div class="page-head">
        <h1 tabIndex={-1}>{t('catalog.title')}</h1>
        <label class="check">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.currentTarget.checked)}
          />
          {t('catalog.showArchived')}
        </label>
      </div>

      {wsList.map((w) => {
        const wsClients = visible(clients.value.filter((c) => c.workspace_id === w.id));
        const internal = visible(
          projects.value.filter((p) => p.workspace_id === w.id && p.client_id === null),
        );
        return (
          <section key={w.id} class="stack" aria-labelledby={`ws-${w.id}`}>
            {multiWorkspace.value && (
              <div class="section-head">
                <h2 id={`ws-${w.id}`}>
                  {w.name}
                  {w.archived && <span class="tag muted">{t('common.archived')}</span>}
                </h2>
                <button
                  type="button"
                  class="btn plain small"
                  onClick={() => setEditing(`w${w.id}`)}
                >
                  {t('common.edit')}
                </button>
              </div>
            )}
            {!multiWorkspace.value && (
              <h2 id={`ws-${w.id}`} class="visually-hidden">
                {w.name}
              </h2>
            )}
            {editing === `w${w.id}` && <WorkspaceEditor workspace={w} onDone={done} />}

            {wsClients.length === 0 && internal.length === 0 && (
              <p class="empty">{t('catalog.empty')}</p>
            )}

            {wsClients.map((c) => (
              <div key={c.id} class="client-block">
                {editing === `c${c.id}` ? (
                  <ClientEditor client={c} onDone={done} />
                ) : (
                  <div class="section-head">
                    <h3>
                      {c.name}
                      {c.hourly_rate !== null && (
                        <span class="cat-meta">
                          {' '}
                          {fmtRate(c.hourly_rate, c.currency ?? settings.value!.currency)}
                        </span>
                      )}
                      {c.archived && <span class="tag muted">{t('common.archived')}</span>}
                    </h3>
                    <button
                      type="button"
                      class="btn plain small"
                      aria-label={`${t('common.edit')}: ${c.name}`}
                      onClick={() => setEditing(`c${c.id}`)}
                    >
                      {t('common.edit')}
                    </button>
                  </div>
                )}
                <ul class="cat-list">
                  {visible(projects.value.filter((p) => p.client_id === c.id)).map(projectRow)}
                </ul>
                {editing === `pnew${c.id}` ? (
                  <ProjectEditor clientId={c.id} workspaceId={w.id} onDone={done} />
                ) : (
                  <button
                    type="button"
                    class="btn plain small"
                    onClick={() => setEditing(`pnew${c.id}`)}
                  >
                    + {t('catalog.addProject')}
                  </button>
                )}
              </div>
            ))}

            {internal.length > 0 && (
              <div class="client-block">
                <h3>{t('catalog.internal')}</h3>
                <ul class="cat-list">{internal.map(projectRow)}</ul>
              </div>
            )}

            <div class="actions start">
              {editing === `cnew${w.id}` ? null : (
                <button type="button" class="btn plain" onClick={() => setEditing(`cnew${w.id}`)}>
                  + {t('catalog.addClient')}
                </button>
              )}
              {editing === `pnewi${w.id}` ? null : (
                <button type="button" class="btn plain" onClick={() => setEditing(`pnewi${w.id}`)}>
                  + {t('catalog.addProject')}
                </button>
              )}
            </div>
            {editing === `cnew${w.id}` && <ClientEditor defaultWorkspaceId={w.id} onDone={done} />}
            {editing === `pnewi${w.id}` && (
              <ProjectEditor clientId={null} workspaceId={w.id} onDone={done} />
            )}
          </section>
        );
      })}

      <section class="stack" aria-labelledby="add-ws">
        <h2 id="add-ws" class="visually-hidden">
          {t('catalog.workspaces')}
        </h2>
        {editing === 'wnew' ? (
          <WorkspaceEditor onDone={done} />
        ) : (
          <button type="button" class="btn plain" onClick={() => setEditing('wnew')}>
            + {t('catalog.addWorkspace')}
          </button>
        )}
      </section>
    </div>
  );
}
