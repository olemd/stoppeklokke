// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CSV (§9): UTF-8 with BOM so Excel opens it correctly. Separator and decimal
 * mark follow the locale (nb: `;` and `,`; en: `,` and `.`) unless overridden.
 * Cells that a spreadsheet would treat as formulas are prefixed with `'`
 * (CSV injection), since descriptions are free text.
 */

export const BOM = '﻿';

export interface CsvFormat {
  sep: ',' | ';' | '\t';
  decimal: '.' | ',';
}

/** Locale default: comma-decimal locales use `;` as separator. */
export function csvFormatFor(locale: string): CsvFormat {
  const decimal = (1.5).toLocaleString(locale).includes(',') ? ',' : '.';
  return { sep: decimal === ',' ? ';' : ',', decimal };
}

export function csvCell(v: string | number | null | undefined, f: CsvFormat): string {
  if (v === null || v === undefined) return '';
  // Numbers (and numeric strings like "1200.00") get the locale's decimal mark
  // and are never treated as formulas, so negative amounts stay numeric.
  const numeric = typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(v);
  let s = numeric ? String(v).replace('.', f.decimal) : v;
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (s.includes(f.sep) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvLine(cells: (string | number | null | undefined)[], f: CsvFormat): string {
  return `${cells.map((c) => csvCell(c, f)).join(f.sep)}\r\n`;
}

/** Minor units → major-unit decimal string with fixed digits ("1200.00"). */
export function minorToDecimal(minor: number, digits: number): number | string {
  if (digits === 0) return minor;
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const base = 10 ** digits;
  return `${sign}${Math.floor(abs / base)}.${String(abs % base).padStart(digits, '0')}`;
}

/** Decimal hours with two digits (7.75). */
export function decimalHours(seconds: number): string {
  return (Math.round((seconds / 3600) * 100) / 100).toFixed(2);
}
