// SPDX-License-Identifier: AGPL-3.0-or-later
/** App shell: auth gating, header with workspace switcher, navigation, routes. */
import { useEffect, useState } from 'preact/hooks';
import { DialogHost } from './components/Dialog';
import { Footer } from './components/Footer';
import { showError, ToastHost } from './components/Toast';
import { patch } from './lib/api';
import { time } from './lib/fmt';
import { setLocale, t } from './lib/i18n';
import { dismissFailed, failedOps, initOffline, pendingCount } from './lib/offline';
import { navigate, onLinkClick, route } from './lib/router';
import { installShortcuts } from './lib/shortcuts';
import {
  activeWorkspaceId,
  activeWorkspaces,
  auth,
  loadAll,
  loadAuth,
  loadTimer,
  multiWorkspace,
  online,
  settings,
  timer,
  viewWorkspace,
  type Settings,
} from './lib/store';
import { Login, MustRegister, Setup } from './screens/Auth';
import { CatalogScreen } from './screens/Catalog';
import { InvoiceScreen } from './screens/Invoice';
import { LogScreen } from './screens/Log';
import { ReportsScreen } from './screens/Reports';
import { SettingsScreen } from './screens/Settings';
import { TimerScreen } from './screens/Timer';
import { Wizard } from './screens/Wizard';

const NAV = [
  { href: '/', key: 'nav.timer' },
  { href: '/log', key: 'nav.log' },
  { href: '/reports', key: 'nav.reports' },
  { href: '/catalog', key: 'nav.catalog' },
  { href: '/settings', key: 'nav.settings' },
];

function WorkspaceSwitcher() {
  if (!multiWorkspace.value) return null;
  const v = viewWorkspace.value === 'all' ? 'all' : String(activeWorkspaceId.value ?? '');
  return (
    <div class="ws-switch">
      <label for="ws-switch" class="visually-hidden">
        {t('nav.workspace')}
      </label>
      <select
        id="ws-switch"
        value={v}
        onChange={async (e) => {
          const val = e.currentTarget.value;
          if (val === 'all') {
            viewWorkspace.value = 'all';
            return;
          }
          viewWorkspace.value = null;
          try {
            settings.value = await patch<Settings>('/settings', {
              active_workspace_id: Number(val),
            });
          } catch (err) {
            showError(err);
          }
        }}
      >
        {activeWorkspaces.value.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
        <option value="all">{t('nav.allWorkspaces')}</option>
      </select>
    </div>
  );
}

function Header() {
  const path = route.value;
  return (
    <header class="header">
      <a class="brand" href="/">
        <span class={`brand-dot ${timer.value ? 'on' : ''}`} aria-hidden="true" />
        {t('app.name')}
      </a>
      <WorkspaceSwitcher />
      <nav class="nav" aria-label={t('nav.label')}>
        <ul>
          {NAV.map((n) => {
            const current = n.href === '/' ? path === '/' : path.startsWith(n.href);
            return (
              <li key={n.href}>
                <a href={n.href} aria-current={current ? 'page' : undefined}>
                  {t(n.key)}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}

function Routes() {
  const path = route.value;
  if (path.startsWith('/log')) return <LogScreen />;
  if (path.startsWith('/reports/invoice')) return <InvoiceScreen />;
  if (path.startsWith('/reports')) return <ReportsScreen />;
  if (path.startsWith('/catalog')) return <CatalogScreen />;
  if (path.startsWith('/settings')) return <SettingsScreen />;
  return <TimerScreen />;
}

/** Offline queue status (§7.3): pending actions and failed replays, never silent. */
function SyncStatus() {
  return (
    <>
      {pendingCount.value > 0 && (
        <p class="offline-banner" role="status">
          {t('offline.pending', { count: pendingCount.value })}
        </p>
      )}
      {failedOps.value.map((f) => (
        <div class="sync-problem" role="alert" key={f.id}>
          <span>{t('offline.failed', { time: time(f.queued_at), message: f.message })}</span>
          <button type="button" class="btn plain small" onClick={() => void dismissFailed(f.id!)}>
            {t('offline.dismiss')}
          </button>
        </div>
      ))}
    </>
  );
}

function Shell({ children, bare = false }: { children: preact.ComponentChildren; bare?: boolean }) {
  return (
    <div class="app" onClick={onLinkClick}>
      <a class="skip" href="#main">
        {t('app.skip')}
      </a>
      {!bare && <Header />}
      {!online.value && (
        <p class="offline-banner" role="status">
          {t('app.offline')}
        </p>
      )}
      {!bare && <SyncStatus />}
      <main id="main" class={bare ? 'main narrow' : 'main'}>
        {children}
      </main>
      <Footer />
      <DialogHost />
      <ToastHost />
    </div>
  );
}

export function App() {
  const [ready, setReady] = useState(false);
  useEffect(installShortcuts, []);
  // Screens read workspaces/clients on mount, so render them only once
  // settings, catalog and timer have ALL loaded.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // The service worker stopped the timer from a notification action.
    navigator.serviceWorker?.addEventListener('message', (e) => {
      if (e.data === 'timer-changed') void loadTimer().catch(() => {});
    });
    loadAuth()
      .catch(showError)
      .finally(() => setReady(true));
  }, []);

  const a = auth.value;
  const authed = a?.authenticated && !a.must_register;
  useEffect(() => {
    if (!authed) return;
    setLoaded(false);
    loadAll()
      .then(() => settings.value && setLocale(settings.value.locale))
      .then(() => setLoaded(true))
      .then(() => initOffline(() => void loadTimer().catch(() => {})))
      .catch(showError);
  }, [authed]);

  if (!ready || !a) return <Shell bare>{<p>{t('app.loading')}</p>}</Shell>;
  if (a.setup_required) {
    if (route.value !== '/setup') navigate(`/setup${location.search}`, true);
    return <Shell bare>{<Setup />}</Shell>;
  }
  if (!a.authenticated) return <Shell bare>{<Login />}</Shell>;
  if (a.must_register) return <Shell bare>{<MustRegister />}</Shell>;
  if (!settings.value || !loaded) return <Shell bare>{<p>{t('app.loading')}</p>}</Shell>;
  if (!settings.value.setup_complete) return <Shell bare>{<Wizard />}</Shell>;
  if (route.value === '/setup') navigate('/', true);
  return (
    <Shell>
      <Routes />
    </Shell>
  );
}
