// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Push notifications for this device (§7.1 #5, §7.2): subscribe with the
 * server's VAPID key, send a test, list and remove devices. Explains the iOS
 * home-screen requirement when the browser has no Notification support.
 */
import { useEffect, useState } from 'preact/hooks';
import { fromBase64Url } from '../../core/crypto';
import { api, get, post } from '../lib/api';
import { dateLong } from '../lib/fmt';
import { t } from '../lib/i18n';
import { defaultPasskeyLabel } from '../lib/passkey';
import { showError, toast } from './Toast';

interface Sub {
  endpoint: string;
  label: string | null;
  created_at: number;
  last_ok_at: number | null;
}

const supported = () =>
  'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

export function PushSettings() {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [k, s] = await Promise.all([
        get<{ key: string | null }>('/push/vapid-public-key'),
        get<Sub[]>('/push/subscriptions'),
      ]);
      setKey(k.key);
      setSubs(s);
      if (supported()) {
        const reg = await navigator.serviceWorker.getRegistration();
        setMine((await reg?.pushManager.getSubscription())?.endpoint ?? null);
      }
    } catch (err) {
      showError(err);
    }
  };
  useEffect(() => void load(), []);

  const enable = async () => {
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== 'granted') {
        toast(t('push.denied'), { kind: 'error' });
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(key!),
      });
      const json = sub.toJSON();
      await post('/push/subscribe', {
        endpoint: sub.endpoint,
        keys: json.keys,
        label: defaultPasskeyLabel(),
      });
      toast(t('push.enabled'));
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  /** Remove a device; for this device also unsubscribe in the browser. */
  const remove = async (endpoint: string) => {
    try {
      if (endpoint === mine) {
        const reg = await navigator.serviceWorker.getRegistration();
        await (await reg?.pushManager.getSubscription())?.unsubscribe();
      }
      await api('/push/subscribe', { method: 'DELETE', json: { endpoint } });
      await load();
    } catch (err) {
      showError(err);
    }
  };

  return (
    <div class="stack">
      <h3>{t('push.title')}</h3>
      {!supported() ? (
        <p class="notice">{t('push.unsupported')}</p>
      ) : key === null ? (
        <p class="notice">{t('push.notConfigured')}</p>
      ) : Notification.permission === 'denied' ? (
        <p class="notice">{t('push.denied')}</p>
      ) : mine && subs.some((s) => s.endpoint === mine) ? (
        <p>{t('push.enabled')}</p>
      ) : (
        <button
          type="button"
          class="btn plain"
          disabled={busy || key === undefined}
          onClick={enable}
        >
          {t('push.enable')}
        </button>
      )}
      {subs.length > 0 && (
        <>
          <h3>{t('push.devices')}</h3>
          <ul class="cat-list">
            {subs.map((s) => (
              <li key={s.endpoint} class="cat-row">
                <span class="cat-name">
                  {s.label ?? new URL(s.endpoint).host}
                  {s.endpoint === mine && <span class="tag">{t('push.enabled')}</span>}
                </span>
                <span class="cat-meta">
                  {s.last_ok_at
                    ? t('settings.lastUsed', { date: dateLong(s.last_ok_at) })
                    : t('settings.neverUsed')}
                </span>
                <button
                  type="button"
                  class="btn plain small"
                  onClick={() => void remove(s.endpoint)}
                >
                  {t('common.delete')}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            class="btn plain"
            onClick={async () => {
              try {
                const r = await post<{ sent: number }>('/push/test');
                toast(t('push.testSent', { count: r.sent }));
              } catch (err) {
                showError(err);
              }
            }}
          >
            {t('push.test')}
          </button>
        </>
      )}
    </div>
  );
}
