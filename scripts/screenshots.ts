// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Regenerates the screenshots in docs/screenshots/ (`bun run screenshots`).
 *
 * Prerequisites:
 *   1. `bun run dev` (or `bunx wrangler dev`) running on http://localhost:8787
 *      with SETUP_TOKEN in .dev.vars,
 *   2. Chromium for Playwright: `node node_modules/playwright/cli.js install chromium`.
 *
 * The LOCAL database's auth is reset and demo data is reloaded (`seed --force`),
 * then the real setup flow runs with Chromium's virtual WebAuthn authenticator,
 * so the screenshots show exactly what a new user sees.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { wrangler } from './lib';

const root = join(import.meta.dir, '..');
const out = join(root, 'docs', 'screenshots');
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const token = /SETUP_TOKEN=(.+)/.exec(readFileSync(join(root, '.dev.vars'), 'utf8'))?.[1]?.trim();
if (!token) throw new Error('SETUP_TOKEN missing in .dev.vars');
mkdirSync(out, { recursive: true });

console.log('Resetting local auth and loading demo data …');
await wrangler([
  'd1',
  'execute',
  'DB',
  '--local',
  '--command',
  'DELETE FROM passkeys; DELETE FROM sessions; DELETE FROM recovery_codes; DELETE FROM auth_challenges; DELETE FROM auth_attempts;',
]);
const seed = Bun.spawnSync(['bun', 'scripts/seed.ts', '--force'], {
  cwd: root,
  stdio: ['inherit', 'inherit', 'inherit'],
});
if (!seed.success) throw new Error('seed failed');

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  locale: 'en-GB',
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

const shot = async (name: string, opts: { fullPage?: boolean; p?: Page } = {}) => {
  await (opts.p ?? page).waitForTimeout(400);
  await (opts.p ?? page).screenshot({
    path: join(out, `${name}.png`),
    fullPage: opts.fullPage ?? false,
  });
  console.log(`  ${name}.png`);
};
const api = (path: string, method = 'GET', body?: unknown) =>
  page.evaluate(
    async ([p, m, b]) => {
      const r = await fetch(`/api${p}`, {
        method: m as string,
        headers: b ? { 'content-type': 'application/json' } : undefined,
        body: b ? JSON.stringify(b) : undefined,
      });
      return r.json();
    },
    [path, method, body] as const,
  );

console.log('Capturing …');
await page.goto(`${BASE}/setup?token=${token}`);
await shot('01-setup');
await page.getByRole('button', { name: 'Register passkey' }).click();
await page.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
await shot('02-recovery-codes');
await page.getByRole('button', { name: 'I have saved them' }).click();
await page.getByRole('button', { name: 'Start timer' }).waitFor();

// A running timer, started 1 h 23 min ago, on a client project.
const projects = (await api('/projects')) as { id: number; name: string }[];
const website = projects.find((p) => p.name === 'Website')!;
const started = (await api('/timer/start', 'POST', {
  project_id: website.id,
  description: 'Landing page copy',
})) as {
  entry: { start_at: number };
};
await api('/timer', 'PATCH', { start_at: started.entry.start_at - 83 * 60 });
await page.reload();
await page.getByRole('button', { name: 'Stop timer' }).waitFor();
await shot('03-timer-running');

await page.getByLabel('Description').fill('Rev');
await page.waitForTimeout(500);
await shot('04-autocomplete');
await page.keyboard.press('Escape');
await page.getByLabel('Description').fill('Landing page copy');
await page.getByRole('combobox', { name: 'Project' }).click();
await shot('05-project-picker');
await page.keyboard.press('Escape');

await page.goto(`${BASE}/log`);
await page.getByRole('button', { name: 'Add time' }).waitFor();
await page.getByRole('button', { name: 'Previous week' }).click();
await page.locator('.day').first().waitFor();
await shot('06-log-week', { fullPage: true });
await page.getByRole('button', { name: 'Edit' }).first().click();
await shot('07-log-edit');

await page.goto(`${BASE}/reports`);
await page.locator('#r-period').selectOption('lastMonth');
await page.locator('#r-group').selectOption('client');
await page.locator('.report-table').waitFor();
await shot('08-reports', { fullPage: true });

await page.goto(`${BASE}/reports/invoice`);
await page.locator('#i-client').selectOption({ label: 'Acme AS' });
await page.locator('.report-table').first().waitFor();
await shot('09-invoice-basis', { fullPage: true });
await page.getByRole('button', { name: 'Lock this period' }).click();
await page.locator('#lock-note').fill('INV-2026-031');
await shot('10-lock-period');
await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

await page.goto(`${BASE}/catalog`);
await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor();
await shot('11-projects', { fullPage: true });
await page.getByRole('button', { name: 'Edit: Acme AS' }).click();
await page.getByLabel('Hourly rate').fill('1400');
await page.getByRole('button', { name: 'Save' }).click();
await page.getByRole('heading', { name: 'The rate changes for existing time' }).waitFor();
await shot('12-rate-change');
await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

await page.goto(`${BASE}/settings`);
await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
await shot('13-settings', { fullPage: true });

// Mobile, Norwegian Bokmål, dark mode.
await api('/settings', 'PATCH', { locale: 'nb' });
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
  storageState: await context.storageState(),
});
const m = await mobile.newPage();
await m.goto(`${BASE}/`);
await m.getByRole('button', { name: 'Stopp klokka' }).waitFor();
await shot('14-mobile-timer-nb-dark', { p: m });
await m.goto(`${BASE}/reports`);
await m.locator('.report-table').waitFor();
await shot('15-mobile-reports-nb-dark', { p: m });
await api('/settings', 'PATCH', { locale: 'en' });
await api('/timer/discard', 'POST');

await browser.close();
console.log(`Screenshots written to ${out}`);
