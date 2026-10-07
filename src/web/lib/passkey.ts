// SPDX-License-Identifier: AGPL-3.0-or-later
/** Browser side of the passkey ceremonies (§5). */
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { post } from './api';
import { t } from './i18n';

export const passkeysSupported = () => browserSupportsWebAuthn();

/** Turn a WebAuthn/browser failure into a message for the user. */
export function passkeyErrorMessage(err: unknown): string {
  const e = err as { name?: string; code?: string; message?: string };
  if (
    e.name === 'NotAllowedError' ||
    e.name === 'AbortError' ||
    e.code === 'ERROR_CEREMONY_ABORTED'
  ) {
    return t('auth.cancelled');
  }
  return t('auth.failed', { message: e.message ?? String(err) });
}

/** Register a passkey. Returns recovery codes on first-time setup. */
export async function registerPasskey(
  label: string,
  setupToken?: string,
): Promise<string[] | undefined> {
  const options = await post<Record<string, unknown>>('/auth/register/options', {
    setup_token: setupToken,
  });
  const response = await startRegistration({ optionsJSON: options as never });
  const r = await post<{ recovery_codes?: string[] }>('/auth/register/verify', {
    response,
    label,
    setup_token: setupToken,
  });
  return r.recovery_codes;
}

export async function loginWithPasskey(): Promise<void> {
  const options = await post<Record<string, unknown>>('/auth/login/options');
  const response = await startAuthentication({ optionsJSON: options as never });
  await post('/auth/login/verify', { response });
}

/** A readable default label for a new passkey ("Firefox on Linux"). */
export function defaultPasskeyLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return [browser, os].filter(Boolean).join(' / ') || t('auth.passkeyLabelDefault');
}
