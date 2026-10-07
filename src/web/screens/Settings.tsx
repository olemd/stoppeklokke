// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings (§7.1 #5): every §4.3 setting (time zone, language, currency and
 * clock first), passkeys, and log out everywhere. Push, API tokens, webhooks
 * and data export/import are added by their milestones.
 */
import { useEffect, useState } from 'preact/hooks';
import { ROUNDING_STEPS } from '../../core/time/duration';
import { confirmAction } from '../components/Dialog';
import { showError, toast } from '../components/Toast';
import { del, get, patch, post } from '../lib/api';
import { dateLong, moneyInput, parseMoney } from '../lib/fmt';
import { withConflicts } from '../lib/flows';
import { localeNames, setLocale, t } from '../lib/i18n';
import { clearOfflineData } from '../lib/offline';
import { defaultPasskeyLabel, passkeyErrorMessage, registerPasskey } from '../lib/passkey';
import { loadAuth, settings, type Settings } from '../lib/store';

const zones = (() => {
  try {
    return ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')];
  } catch {
    return ['UTC'];
  }
})();
const currencies = (() => {
  try {
    return Intl.supportedValuesOf('currency');
  } catch {
    return ['EUR', 'NOK'];
  }
})();

interface Passkey {
  id: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

async function update(body: Partial<Settings> & Record<string, unknown>) {
  try {
    const r = await withConflicts((x) =>
      patch<Settings & { rate_change_result?: { locked: number } }>('/settings', { ...body, ...x }),
    );
    if (!r) return;
    const { rate_change_result, ...rest } = r;
    settings.value = rest as Settings;
    if (body.locale) await setLocale(body.locale);
    toast(
      rate_change_result?.locked
        ? t('rateChange.locked', { count: rate_change_result.locked })
        : t('common.saved'),
    );
  } catch (err) {
    showError(err);
  }
}

function NumberSetting({
  id,
  label,
  value,
  suffix,
  onSave,
}: {
  id: string;
  label: string;
  value: number;
  suffix?: string;
  onSave: (n: number) => void;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <div class="inline">
        <input
          id={id}
          inputMode="numeric"
          value={v}
          onInput={(e) => setV(e.currentTarget.value)}
          onBlur={() => {
            const n = Number(v);
            if (Number.isInteger(n) && n >= 0 && n !== value) onSave(n);
            else setV(String(value));
          }}
        />
        {suffix && <span class="suffix">{suffix}</span>}
      </div>
    </div>
  );
}

export function SettingsScreen() {
  const s = settings.value!;
  const [names, setNames] = useState<{ code: string; name: string }[]>([]);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [rateText, setRateText] = useState(moneyInput(s.default_hourly_rate, s.currency));
  const [quiet, setQuiet] = useState(s.quiet_hours);
  const loadPasskeys = () => get<Passkey[]>('/auth/passkeys').then(setPasskeys).catch(showError);

  useEffect(() => {
    localeNames().then(setNames);
    void loadPasskeys();
  }, []);

  const sel = (key: keyof Settings) => (e: Event) =>
    update({ [key]: (e.currentTarget as HTMLSelectElement).value });

  return (
    <div class="settings stack">
      <h1 tabIndex={-1}>{t('settings.title')}</h1>

      <section class="panel stack" aria-labelledby="s-general">
        <h2 id="s-general">{t('settings.general')}</h2>
        <div class="grid-2">
          <div class="field">
            <label for="s-tz">{t('settings.timezone')}</label>
            <select id="s-tz" value={s.timezone} onChange={sel('timezone')}>
              {zones.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="s-lang">{t('settings.language')}</label>
            <select id="s-lang" value={s.locale} onChange={sel('locale')}>
              {names.map((n) => (
                <option key={n.code} value={n.code}>
                  {n.name}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="s-cur">{t('settings.currency')}</label>
            <select id="s-cur" value={s.currency} onChange={sel('currency')}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="s-clock">{t('settings.clock')}</label>
            <select id="s-clock" value={s.clock_format} onChange={sel('clock_format')}>
              <option value="24h">{t('wizard.clock24')}</option>
              <option value="12h">{t('wizard.clock12')}</option>
            </select>
          </div>
          <div class="field">
            <label for="s-rate">{t('settings.defaultRate')}</label>
            <input
              id="s-rate"
              inputMode="decimal"
              placeholder={t('catalog.rateNone')}
              value={rateText}
              onInput={(e) => setRateText(e.currentTarget.value)}
              onBlur={() => {
                const v = rateText.trim() === '' ? null : parseMoney(rateText, s.currency);
                if (rateText.trim() !== '' && v === null)
                  return toast(t('common.invalidAmount'), { kind: 'error' });
                if (v !== s.default_hourly_rate) void update({ default_hourly_rate: v });
              }}
            />
          </div>
          <div class="field">
            <label for="s-orc">{t('settings.onRateChange')}</label>
            <select id="s-orc" value={s.on_rate_change} onChange={sel('on_rate_change')}>
              <option value="ask">{t('settings.onRateChangeAsk')}</option>
              <option value="lock">{t('settings.onRateChangeLock')}</option>
              <option value="update">{t('settings.onRateChangeUpdate')}</option>
            </select>
          </div>
          <div class="field">
            <label for="s-round">{t('settings.rounding')}</label>
            <div class="inline">
              <select
                id="s-round"
                value={s.rounding_min}
                onChange={(e) => update({ rounding_min: Number(e.currentTarget.value) })}
              >
                {ROUNDING_STEPS.map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? t('settings.roundingNone') : t('settings.roundingMin', { min: m })}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('settings.rounding')}
                value={s.rounding_mode}
                disabled={!s.rounding_min}
                onChange={sel('rounding_mode')}
              >
                <option value="nearest">{t('settings.roundingNearest')}</option>
                <option value="up">{t('settings.roundingUp')}</option>
                <option value="down">{t('settings.roundingDown')}</option>
              </select>
            </div>
          </div>
          <NumberSetting
            id="s-target"
            label={t('settings.dailyTarget')}
            value={s.daily_target_min}
            suffix={t('settings.minutes')}
            onSave={(n) => update({ daily_target_min: n })}
          />
        </div>
        <label class="check">
          <input
            type="checkbox"
            checked={s.billable_default}
            onChange={(e) => update({ billable_default: e.currentTarget.checked })}
          />
          {t('settings.billableDefault')}
        </label>
      </section>

      <section class="panel stack" aria-labelledby="s-notif">
        <h2 id="s-notif">{t('settings.notifications')}</h2>
        <div class="grid-2">
          <NumberSetting
            id="s-alert"
            label={t('settings.alertAfter')}
            value={s.alert_after_min}
            suffix={t('settings.minutes')}
            onSave={(n) => update({ alert_after_min: n })}
          />
          <NumberSetting
            id="s-tick"
            label={t('settings.tickInterval')}
            value={s.tick_interval_min}
            suffix={t('settings.minutes')}
            onSave={(n) => update({ tick_interval_min: n })}
          />
          <div class="field">
            <label for="s-quiet">{t('settings.quietHours')}</label>
            <input
              id="s-quiet"
              value={quiet}
              placeholder="23:00-07:00"
              onInput={(e) => setQuiet(e.currentTarget.value)}
              onBlur={() => quiet !== s.quiet_hours && update({ quiet_hours: quiet.trim() })}
            />
          </div>
          <NumberSetting
            id="s-idle"
            label={t('settings.idleStop')}
            value={s.idle_stop_after_min}
            suffix={t('settings.minutes')}
            onSave={(n) => update({ idle_stop_after_min: n })}
          />
        </div>
      </section>

      <section class="panel stack" aria-labelledby="s-pk">
        <h2 id="s-pk">{t('settings.passkeys')}</h2>
        <ul class="cat-list">
          {passkeys.map((p) => (
            <li key={p.id} class="cat-row">
              <span class="cat-name">{p.label}</span>
              <span class="cat-meta">
                {p.last_used_at
                  ? t('settings.lastUsed', { date: dateLong(p.last_used_at) })
                  : t('settings.neverUsed')}
              </span>
              {passkeys.length > 1 && (
                <button
                  type="button"
                  class="btn plain small"
                  aria-label={`${t('common.delete')}: ${p.label}`}
                  onClick={async () => {
                    if (
                      !(await confirmAction(
                        t('settings.deletePasskeyConfirm', { label: p.label }),
                        t('common.delete'),
                        true,
                      ))
                    )
                      return;
                    try {
                      await del(`/auth/passkeys/${encodeURIComponent(p.id)}`);
                      await loadPasskeys();
                    } catch (err) {
                      showError(err);
                    }
                  }}
                >
                  {t('common.delete')}
                </button>
              )}
            </li>
          ))}
        </ul>
        <button
          type="button"
          class="btn plain"
          onClick={async () => {
            try {
              await registerPasskey(defaultPasskeyLabel());
              toast(t('common.saved'));
              await loadPasskeys();
            } catch (err) {
              toast(passkeyErrorMessage(err), { kind: 'error' });
            }
          }}
        >
          + {t('settings.addPasskey')}
        </button>
      </section>

      <section class="panel stack" aria-labelledby="s-sec">
        <h2 id="s-sec">{t('settings.security')}</h2>
        <div class="actions start">
          <button
            type="button"
            class="btn plain"
            onClick={async () => {
              await post('/auth/logout').catch(showError);
              navigator.serviceWorker?.controller?.postMessage('clear-api-cache');
              await clearOfflineData();
              await loadAuth();
            }}
          >
            {t('auth.logout')}
          </button>
          <button
            type="button"
            class="btn danger-plain"
            onClick={async () => {
              if (
                !(await confirmAction(
                  t('settings.logoutAllConfirm'),
                  t('settings.logoutAll'),
                  true,
                ))
              )
                return;
              await post('/auth/logout-all').catch(showError);
              navigator.serviceWorker?.controller?.postMessage('clear-api-cache');
              await clearOfflineData();
              await loadAuth();
            }}
          >
            {t('settings.logoutAll')}
          </button>
        </div>
      </section>
    </div>
  );
}
