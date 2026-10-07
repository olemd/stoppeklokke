// SPDX-License-Identifier: AGPL-3.0-or-later
import { Footer } from './components/Footer';
import { t } from './lib/i18n';

export function App() {
  return (
    <>
      <main class="main">
        <h1>{t('app.name')}</h1>
      </main>
      <Footer />
    </>
  );
}
