// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Display helpers bound to the stored settings. All formatting goes through
 * core/time/format with explicit time zone and clock (§3): the browser's own
 * zone and locale are never consulted after setup.
 */
import { formatHM } from '../../core/time/duration';
import {
  currencyDigits,
  formatDate,
  formatDateLong,
  formatMoney,
  formatTime,
  type DisplayPrefs,
} from '../../core/time/format';
import type { Entry } from '../../shared/schemas';
import { translator } from './i18n';
import { clientById, projectById, settings } from './store';

export function prefs(): DisplayPrefs {
  const s = settings.value;
  return {
    timezone: s?.timezone ?? 'UTC',
    locale: translator.value.locale,
    clock: s?.clock_format ?? '24h',
  };
}

export const time = (epoch: number) => formatTime(epoch, prefs());
export const date = (epoch: number) => formatDate(epoch, prefs());
export const dateLong = (epoch: number) => formatDateLong(epoch, prefs());
export const hm = formatHM;
export const money = (minor: number, currency: string) =>
  formatMoney(minor, currency, prefs().locale);
export const rate = (minor: number | null, currency: string) =>
  minor === null ? '' : money(minor, currency);

/** Parse a typed amount in major units ("1200", "1 200,50") into minor units. */
export function parseMoney(input: string, currency: string): number | null {
  const s = input.replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 10 ** currencyDigits(currency));
}

/** Minor units → plain editable major-unit string ("1200", "1200.5"). */
export function moneyInput(minor: number | null, currency: string): string {
  if (minor === null) return '';
  return String(minor / 10 ** currencyDigits(currency));
}

/** "Project · Client" style label for an entry (or "Uncategorised"). */
export function entryLabel(
  e: Pick<Entry, 'project_id' | 'client_id'>,
  uncategorised: string,
): string {
  const p = e.project_id !== null ? projectById.value.get(e.project_id) : null;
  const c = e.client_id !== null ? clientById.value.get(e.client_id) : null;
  if (p && c) return `${p.name} (${c.name})`;
  return p?.name ?? c?.name ?? uncategorised;
}

export function entryColor(e: Pick<Entry, 'project_id'>): string | undefined {
  return e.project_id !== null ? projectById.value.get(e.project_id)?.color : undefined;
}
