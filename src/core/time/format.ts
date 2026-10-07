// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The ONLY place that formats dates and times for display (§3).
 *
 * Every formatter passes `timeZone` and `hourCycle` explicitly: the stored
 * `timezone` setting wins over the browser, and `clock_format` is never
 * derived from the locale (locale=en must still show 14:30, not 2:30 PM).
 */

export interface DisplayPrefs {
  timezone: string;
  locale: string;
  clock: '24h' | '12h';
}

const cache = new Map<string, Intl.DateTimeFormat>();

/**
 * Generic `en` gives US-style dates ("Wed, Oct 7"); the UI uses day-month
 * order ("Wed 7 Oct", §3), so English dates are formatted as en-GB.
 */
const dateLocale = (locale: string) => (locale === 'en' ? 'en-GB' : locale);

function fmt(prefs: DisplayPrefs, kind: string, opts: Intl.DateTimeFormatOptions) {
  const key = `${kind}|${prefs.locale}|${prefs.timezone}|${prefs.clock}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(dateLocale(prefs.locale), { timeZone: prefs.timezone, ...opts });
    cache.set(key, f);
  }
  return f;
}

const hourCycle = (p: DisplayPrefs) => (p.clock === '12h' ? 'h12' : 'h23');

/** `14:30` (or `2:30 PM` with clock=12h). */
export function formatTime(epoch: number, prefs: DisplayPrefs): string {
  return fmt(prefs, 'time', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: hourCycle(prefs),
  }).format(epoch * 1000);
}

/** Short localized date: `Wed 7 Oct` / `ons. 7. okt.`. */
export function formatDate(epoch: number, prefs: DisplayPrefs): string {
  return fmt(prefs, 'date', { weekday: 'short', day: 'numeric', month: 'short' }).format(
    epoch * 1000,
  );
}

/** Localized date with year, for reports and lock lists. */
export function formatDateLong(epoch: number, prefs: DisplayPrefs): string {
  return fmt(prefs, 'datelong', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    epoch * 1000,
  );
}

export function formatDateTime(epoch: number, prefs: DisplayPrefs): string {
  return `${formatDate(epoch, prefs)} ${formatTime(epoch, prefs)}`;
}

/** Format a calendar date ('YYYY-MM-DD') without a time-zone shift. */
export function formatCalendarDate(date: string, prefs: Pick<DisplayPrefs, 'locale'>): string {
  const key = `cal|${prefs.locale}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(dateLocale(prefs.locale), {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    cache.set(key, f);
  }
  return f.format(Date.parse(`${date}T12:00:00Z`));
}

/** Decimal hours with the locale's decimal mark: 7.75 / 7,75. */
export function formatDecimalHours(seconds: number, locale: string, digits = 2): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(seconds / 3600);
}

/** Money from minor units: `1 200,00 kr` / `€1,200.00`. */
export function formatMoney(minor: number, currency: string, locale: string): string {
  const nf = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
  return nf.format(minor / 10 ** digits);
}

/** Number of minor-unit digits for a currency (NOK/EUR: 2, JPY: 0). */
export function currencyDigits(currency: string): number {
  return (
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * Parse a user-typed `HH:MM` (also `H:MM`, `HHMM`, `H`) into hours/minutes.
 * Used by the custom time input, since <input type="time"> follows the browser
 * locale and may show 12-hour clocks (§3).
 */
export function parseClock(input: string): { hour: number; minute: number } | null {
  const s = input.trim();
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?$/.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}
