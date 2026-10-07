// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { catalogs } from '../src/shared/i18n/catalogs.generated';
import { createTranslator, suggestLocale, type Catalogs } from '../src/shared/i18n/translate';

const fake: Catalogs = {
  en: {
    _meta: { name: 'English', englishName: 'English', dir: 'ltr' },
    a: { hours_one: '{count} hour', hours_other: '{count} hours', only_en: 'EN', hi: 'Hi {name}' },
  },
  nb: {
    _meta: { name: 'Norsk', englishName: 'Norwegian', dir: 'ltr' },
    a: { hours_one: '{count} time', hours_other: '{count} timer', hi: 'Hei {name}' },
  },
};

describe('translator', () => {
  it('interpolates and pluralises', () => {
    const { t } = createTranslator('nb', fake);
    expect(t('a.hours', { count: 1 })).toBe('1 time');
    expect(t('a.hours', { count: 3 })).toBe('3 timer');
    expect(t('a.hi', { name: 'Ole' })).toBe('Hei Ole');
  });

  it('falls back nb-NO → nb → en and reports missing keys', () => {
    const missing: string[] = [];
    const { t, locale } = createTranslator('nb-NO', fake, (k) => missing.push(k));
    expect(locale).toBe('nb');
    expect(t('a.only_en')).toBe('EN');
    expect(missing).toEqual(['a.only_en']);
    expect(t('a.nope')).toBe('a.nope');
  });

  it('suggests a locale from browser preferences', () => {
    expect(suggestLocale(['de-DE', 'nn-NO'], ['en', 'nb'])).toBe('nb');
    expect(suggestLocale(['no'], ['en', 'nb'])).toBe('nb');
    expect(suggestLocale(['nb-NO'], ['en', 'nb'])).toBe('nb');
    expect(suggestLocale(['fr'], ['en', 'nb'])).toBe('en');
  });

  it('ships en and nb', () => {
    expect(Object.keys(catalogs).sort()).toEqual(['en', 'nb']);
    expect(createTranslator('nb', catalogs).t('app.source')).toBe('Kildekode (AGPL-3.0)');
  });
});
