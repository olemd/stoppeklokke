// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Setup-time suggestions (§4.3). Kept free of zod so the web bundle can use
 * them without pulling in the validation library.
 */

/** Suggested currency for a locale: nb → NOK, otherwise EUR. */
export function suggestCurrency(locale: string): string {
  return locale.toLowerCase().startsWith('nb') ? 'NOK' : 'EUR';
}
