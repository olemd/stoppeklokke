// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings wizard after setup (§4.3, §5.1). Time zone, language and currency
 * are suggested from the browser here, once; after this the stored values
 * always win.
 */
import { useEffect, useState } from 'preact/hooks';
import { suggestCurrency } from '../../core/settings/suggest';
import { suggestLocale } from '../../shared/i18n/translate';
import { showError } from '../components/Toast';
import { patch, post } from '../lib/api';
import { availableLocales, localeNames, setLocale, t } from '../lib/i18n';
import { loadAll, workspaces } from '../lib/store';

const zones = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
})();
const currencies = (() => {
  try {
    return Intl.supportedValuesOf('currency');
  } catch {
    return ['EUR', 'NOK', 'SEK', 'DKK', 'USD', 'GBP'];
  }
})();

export function Wizard() {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const initialLocale = suggestLocale(
    navigator.languages ?? [navigator.language],
    availableLocales,
  );
  const [locale, setLoc] = useState(initialLocale);
  const [names, setNames] = useState<{ code: string; name: string }[]>([]);
  const [form, setForm] = useState({
    workspace: '',
    timezone: zones.includes(browserZone) ? browserZone : 'UTC',
    currency: suggestCurrency(initialLocale),
    clock_format: '24h' as '24h' | '12h',
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    localeNames().then(setNames);
    void setLocale(locale);
  }, [locale]);

  const set = (k: keyof typeof form) => (e: Event) =>
    setForm({ ...form, [k]: (e.currentTarget as HTMLInputElement).value });

  return (
    <section class="panel stack" aria-labelledby="wiz-title">
      <h1 id="wiz-title" tabIndex={-1}>
        {t('wizard.title')}
      </h1>
      <p>{t('wizard.intro')}</p>
      <form
        class="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            if (workspaces.value.length === 0) {
              await post('/workspaces', {
                name: form.workspace.trim() || t('wizard.workspaceDefault'),
              });
            }
            await patch('/settings', {
              timezone: form.timezone,
              locale,
              currency: form.currency,
              clock_format: form.clock_format,
              setup_complete: true,
            });
            await loadAll();
          } catch (err) {
            showError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {workspaces.value.length === 0 && (
          <div class="field">
            <label for="wz-ws">{t('wizard.workspace')}</label>
            <input
              id="wz-ws"
              value={form.workspace}
              placeholder={t('wizard.workspaceDefault')}
              aria-describedby="wz-ws-hint"
              maxLength={200}
              onInput={set('workspace')}
            />
            <span id="wz-ws-hint" class="hint">
              {t('wizard.workspaceHint')}
            </span>
          </div>
        )}
        <div class="field">
          <label for="wz-lang">{t('wizard.language')}</label>
          <select id="wz-lang" value={locale} onChange={(e) => setLoc(e.currentTarget.value)}>
            {names.map((n) => (
              <option key={n.code} value={n.code}>
                {n.name}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="wz-tz">{t('wizard.timezone')}</label>
          <select id="wz-tz" value={form.timezone} onChange={set('timezone')}>
            {['UTC', ...zones.filter((z) => z !== 'UTC')].map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="wz-cur">{t('wizard.currency')}</label>
          <select id="wz-cur" value={form.currency} onChange={set('currency')}>
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <fieldset class="field">
          <legend>{t('wizard.clock')}</legend>
          {(['24h', '12h'] as const).map((v) => (
            <label key={v} class="radio">
              <input
                type="radio"
                name="clock"
                value={v}
                checked={form.clock_format === v}
                onChange={() => setForm({ ...form, clock_format: v })}
              />
              {t(v === '24h' ? 'wizard.clock24' : 'wizard.clock12')}
            </label>
          ))}
        </fieldset>
        <button type="submit" class="btn primary" disabled={busy}>
          {t('wizard.finish')}
        </button>
      </form>
    </section>
  );
}
