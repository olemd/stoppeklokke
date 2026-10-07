// SPDX-License-Identifier: AGPL-3.0-or-later
/** Settings: personal API tokens and outgoing webhooks (§7.1 #5, §15.3). */
import { useEffect, useState } from 'preact/hooks';
import { parseDate, zonedToEpoch } from '../../core/time/tz';
import { del, get, patch, post } from '../lib/api';
import { dateLong } from '../lib/fmt';
import { t } from '../lib/i18n';
import { settings } from '../lib/store';
import { confirmAction } from './Dialog';
import { showError, toast } from './Toast';

const EVENTS = [
  'timer.started',
  'timer.stopped',
  'entry.created',
  'entry.updated',
  'entry.deleted',
  'lock.created',
  'lock.deleted',
  'rate.changed',
  'alert.sent',
];

/** A freshly created secret, shown once with a copy button. */
function SecretOnce({ value, note }: { value: string; note: string }) {
  return (
    <div class="notice stack" role="status">
      <p>{note}</p>
      <div class="inline">
        <code class="secret">{value}</code>
        <button
          type="button"
          class="btn plain small"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast(t('tokens.copied'));
          }}
        >
          {t('tokens.copy')}
        </button>
      </div>
    </div>
  );
}

interface Token {
  id: number;
  name: string;
  prefix: string;
  scope: 'read' | 'write';
  expires_at: number | null;
  last_used_at: number | null;
}

export function TokenSettings() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [expires, setExpires] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const load = () => get<Token[]>('/tokens').then(setTokens).catch(showError);
  useEffect(() => void load(), []);

  return (
    <section class="panel stack" aria-labelledby="s-tokens">
      <h2 id="s-tokens">{t('tokens.title')}</h2>
      <p class="hint">
        {t('tokens.intro')} <a href="/api/openapi.json">{t('tokens.apiDocs')}</a>
      </p>
      {fresh && <SecretOnce value={fresh} note={t('tokens.created')} />}
      <ul class="cat-list">
        {tokens.length === 0 && <li class="empty">{t('tokens.none')}</li>}
        {tokens.map((tk) => (
          <li key={tk.id} class="cat-row">
            <span class="cat-name">
              {tk.name} <code>{tk.prefix}…</code>{' '}
              <span class="tag">{tk.scope === 'write' ? t('tokens.write') : t('tokens.read')}</span>
            </span>
            <span class="cat-meta">
              {tk.last_used_at
                ? t('tokens.lastUsed', { date: dateLong(tk.last_used_at) })
                : t('tokens.neverUsed')}
              {tk.expires_at ? ` · ${t('tokens.expires')} ${dateLong(tk.expires_at)}` : ''}
            </span>
            <button
              type="button"
              class="btn plain small"
              onClick={async () => {
                if (
                  !(await confirmAction(
                    t('tokens.revokeConfirm', { name: tk.name }),
                    t('tokens.revoke'),
                    true,
                  ))
                )
                  return;
                await del(`/tokens/${tk.id}`).catch(showError);
                await load();
              }}
            >
              {t('tokens.revoke')}
            </button>
          </li>
        ))}
      </ul>
      <form
        class="grid-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            let expires_at: number | null = null;
            if (expires) {
              const { year, month, day } = parseDate(expires);
              expires_at = zonedToEpoch(year, month, day + 1, 0, 0, settings.value!.timezone);
            }
            const r = await post<{ token: string }>('/tokens', { name, scope, expires_at });
            setFresh(r.token);
            setName('');
            await load();
          } catch (err) {
            showError(err);
          }
        }}
      >
        <div class="field">
          <label for="tk-name">{t('tokens.name')}</label>
          <input
            id="tk-name"
            required
            maxLength={100}
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="tk-scope">{t('tokens.scope')}</label>
          <select
            id="tk-scope"
            value={scope}
            onChange={(e) => setScope(e.currentTarget.value as 'read' | 'write')}
          >
            <option value="read">{t('tokens.read')}</option>
            <option value="write">{t('tokens.write')}</option>
          </select>
        </div>
        <div class="field">
          <label for="tk-exp">
            {t('tokens.expires')} ({t('common.optional')})
          </label>
          <input
            id="tk-exp"
            type="date"
            value={expires}
            onInput={(e) => setExpires(e.currentTarget.value)}
          />
        </div>
        <div class="actions start">
          <button class="btn plain">{t('tokens.create')}</button>
        </div>
      </form>
    </section>
  );
}

interface Hook {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  last_status: number | null;
  last_error: string | null;
}

export function WebhookSettings() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['timer.started', 'timer.stopped']);
  const [fresh, setFresh] = useState<string | null>(null);
  const load = () => get<Hook[]>('/webhooks').then(setHooks).catch(showError);
  useEffect(() => void load(), []);

  return (
    <section class="panel stack" aria-labelledby="s-hooks">
      <h2 id="s-hooks">{t('webhooks.title')}</h2>
      <p class="hint">{t('webhooks.intro')}</p>
      {fresh && <SecretOnce value={fresh} note={t('webhooks.created')} />}
      <ul class="cat-list">
        {hooks.length === 0 && <li class="empty">{t('webhooks.none')}</li>}
        {hooks.map((hk) => (
          <li key={hk.id} class="cat-row wrap">
            <span class="cat-name">
              <code>{hk.url}</code>
              <span class="cat-meta"> {hk.events.join(', ')}</span>
            </span>
            {hk.last_status !== null && (
              <span class="cat-meta">
                {hk.last_error
                  ? t('webhooks.failed', { error: hk.last_error })
                  : t('webhooks.ok', { status: hk.last_status })}
              </span>
            )}
            <label class="check">
              <input
                type="checkbox"
                checked={hk.active}
                onChange={async (e) => {
                  await patch(`/webhooks/${hk.id}`, { active: e.currentTarget.checked }).catch(
                    showError,
                  );
                  await load();
                }}
              />
              {t('webhooks.active')}
            </label>
            <button
              type="button"
              class="btn plain small"
              onClick={async () => {
                try {
                  const r = await post<{ status: number }>(`/webhooks/${hk.id}/test`);
                  toast(t('webhooks.tested', { status: r.status }));
                } catch (err) {
                  showError(err);
                }
                await load();
              }}
            >
              {t('webhooks.test')}
            </button>
            <button
              type="button"
              class="btn plain small"
              onClick={async () => {
                if (!(await confirmAction(t('webhooks.deleteConfirm'), t('webhooks.delete'), true)))
                  return;
                await del(`/webhooks/${hk.id}`).catch(showError);
                await load();
              }}
            >
              {t('webhooks.delete')}
            </button>
          </li>
        ))}
      </ul>
      <form
        class="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await post<{ secret: string }>('/webhooks', { url, events });
            setFresh(r.secret);
            setUrl('');
            await load();
          } catch (err) {
            showError(err);
          }
        }}
      >
        <div class="field">
          <label for="wh-url">{t('webhooks.url')}</label>
          <input
            id="wh-url"
            type="url"
            required
            pattern="https://.*"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
        </div>
        <fieldset class="field">
          <legend>{t('webhooks.events')}</legend>
          <div class="event-grid">
            {EVENTS.map((ev) => (
              <label key={ev} class="check">
                <input
                  type="checkbox"
                  checked={events.includes(ev)}
                  onChange={(e) =>
                    setEvents(
                      e.currentTarget.checked ? [...events, ev] : events.filter((x) => x !== ev),
                    )
                  }
                />
                <code>{ev}</code>
              </label>
            ))}
          </div>
        </fieldset>
        <div class="actions start">
          <button class="btn plain" disabled={events.length === 0}>
            {t('webhooks.create')}
          </button>
        </div>
      </form>
    </section>
  );
}
