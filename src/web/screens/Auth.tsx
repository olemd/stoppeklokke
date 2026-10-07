// SPDX-License-Identifier: AGPL-3.0-or-later
/** Setup, login, recovery and "register a new passkey" screens (§5). */
import { useState } from 'preact/hooks';
import { toast } from '../components/Toast';
import { ApiError, post } from '../lib/api';
import { t } from '../lib/i18n';
import {
  defaultPasskeyLabel,
  loginWithPasskey,
  passkeyErrorMessage,
  passkeysSupported,
  registerPasskey,
} from '../lib/passkey';
import { query } from '../lib/router';
import { loadAuth } from '../lib/store';

function Unsupported() {
  return passkeysSupported() ? null : (
    <p class="notice error" role="alert">
      {t('auth.notSupported')}
    </p>
  );
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'rate_limited') return t('auth.rateLimited');
    if (err.code === 'bad_recovery_code') return t('auth.badRecovery');
    return t('auth.failed', { message: err.message });
  }
  return passkeyErrorMessage(err);
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <section class="panel stack" aria-labelledby="rc-title">
      <h1 id="rc-title" tabIndex={-1}>
        {t('auth.recoveryTitle')}
      </h1>
      <p>{t('auth.recoveryIntro')}</p>
      <ol class="codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div class="actions">
        <button
          type="button"
          class="btn plain"
          onClick={async () => {
            await navigator.clipboard.writeText(codes.join('\n'));
            toast(t('auth.recoveryCopied'));
          }}
        >
          {t('auth.recoveryCopy')}
        </button>
        <button type="button" class="btn primary" onClick={onDone}>
          {t('auth.recoverySaved')}
        </button>
      </div>
    </section>
  );
}

export function Setup() {
  const token = query.value.get('token') ?? '';
  const [label, setLabel] = useState(defaultPasskeyLabel());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);

  if (codes) {
    return (
      <RecoveryCodes
        codes={codes}
        onDone={async () => {
          // Drop the token from the address bar and history.
          history.replaceState(null, '', '/');
          await loadAuth();
        }}
      />
    );
  }

  return (
    <section class="panel stack" aria-labelledby="setup-title">
      <h1 id="setup-title" tabIndex={-1}>
        {t('auth.setupTitle')}
      </h1>
      <Unsupported />
      {!token ? (
        <p class="notice error">{t('auth.setupMissingToken')}</p>
      ) : (
        <form
          class="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              setCodes((await registerPasskey(label, token)) ?? []);
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>{t('auth.setupIntro')}</p>
          <div class="field">
            <label for="pk-label">{t('auth.passkeyLabel')}</label>
            <input
              id="pk-label"
              value={label}
              maxLength={100}
              onInput={(e) => setLabel(e.currentTarget.value)}
            />
          </div>
          {error && (
            <p class="notice error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" class="btn primary" disabled={busy}>
            {t('auth.registerPasskey')}
          </button>
        </form>
      )}
    </section>
  );
}

export function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await loadAuth();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="panel stack" aria-labelledby="login-title">
      <h1 id="login-title" tabIndex={-1}>
        {t('auth.loginTitle')}
      </h1>
      <Unsupported />
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        class="btn primary large"
        disabled={busy}
        onClick={() => run(loginWithPasskey)}
      >
        {t('auth.loginPasskey')}
      </button>
      <details>
        <summary>{t('auth.useRecovery')}</summary>
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => post('/auth/recovery', { code }));
          }}
        >
          <div class="field">
            <label for="rc">{t('auth.recoveryCode')}</label>
            <input
              id="rc"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellcheck={false}
              value={code}
              onInput={(e) => setCode(e.currentTarget.value)}
              required
            />
          </div>
          <button type="submit" class="btn plain" disabled={busy}>
            {t('auth.recoveryLogin')}
          </button>
        </form>
      </details>
    </section>
  );
}

export function MustRegister() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section class="panel stack" aria-labelledby="mr-title">
      <h1 id="mr-title" tabIndex={-1}>
        {t('auth.mustRegisterTitle')}
      </h1>
      <p>{t('auth.mustRegisterIntro')}</p>
      <Unsupported />
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        class="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await registerPasskey(defaultPasskeyLabel());
            await loadAuth();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('auth.registerPasskey')}
      </button>
    </section>
  );
}
