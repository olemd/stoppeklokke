// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from 'preact';
import { App } from './App';

render(<App />, document.getElementById('app')!);

// Service worker (§7.2): production builds only, so dev reloads stay simple.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js');
}
