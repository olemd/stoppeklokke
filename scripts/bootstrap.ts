// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One-time interactive setup of a new Stoppeklokke instance on your own
 * Cloudflare account (§11):
 *   1. creates the D1 database and applies migrations,
 *   2. deploys the Worker,
 *   3. generates VAPID keys and a SETUP_TOKEN and stores them as Worker secrets,
 *   4. prints (or sets, via `gh`) the GitHub Variables/Secrets CI needs,
 *   5. prints the /setup URL for registering your first passkey.
 *
 * Prerequisites: `bunx wrangler login` (or CLOUDFLARE_API_TOKEN in the env).
 * Values are saved to .env (git-ignored) so `bun run render-config` reuses them.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask, generateVapidKeys, randomSetupToken, wrangler } from './lib';

const root = join(import.meta.dir, '..');
const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(' ')} failed`);
};

console.log('Stoppeklokke bootstrap\n');
const who = JSON.parse(await wrangler(['whoami', '--json'])) as {
  accounts?: { id: string; name: string }[];
};
const accounts = who.accounts ?? [];
if (accounts.length === 0)
  throw new Error('No Cloudflare account found. Run `bunx wrangler login`.');
let accountId = accounts[0]!.id;
if (accounts.length > 1) {
  for (const [i, a] of accounts.entries()) console.log(`  ${i + 1}) ${a.name} (${a.id})`);
  accountId = accounts[Number(ask('Which account?', '1')) - 1]!.id;
}
process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

const workerName = ask('Worker name', 'stoppeklokke');
const customDomain = ask('Custom domain (zone must be on Cloudflare; empty = *.workers.dev)');
const origin = customDomain
  ? `https://${customDomain}`
  : ask('Public origin (e.g. https://stoppeklokke.<you>.workers.dev)');
const rpId = new URL(origin).hostname;
const sourceUrl = ask(
  'Source code URL (must be YOUR repo if you modify the code, AGPL §13)',
  'https://github.com/olemd/stoppeklokke',
);
const vapidSubject = ask('Contact for push services (mailto:you@example.com)');

console.log('\nCreating D1 database …');
const existing = JSON.parse(await wrangler(['d1', 'list', '--json'])) as {
  uuid: string;
  name: string;
}[];
let db = existing.find((d) => d.name === workerName);
if (!db) {
  await wrangler(['d1', 'create', workerName]);
  db = (JSON.parse(await wrangler(['d1', 'list', '--json'])) as typeof existing).find(
    (d) => d.name === workerName,
  );
}
if (!db) throw new Error('Could not find the D1 database after creating it');

const vars = {
  WORKER_NAME: workerName,
  ORIGIN: origin,
  RP_ID: rpId,
  D1_DATABASE_ID: db.uuid,
  CUSTOM_DOMAIN: customDomain,
  SOURCE_URL: sourceUrl,
};
writeFileSync(
  join(root, '.env'),
  `${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\nCLOUDFLARE_ACCOUNT_ID=${accountId}\n`,
);
Object.assign(process.env, vars);

await run(['bun', 'run', 'build']);
await run(['bunx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote']);
await run(['bunx', 'wrangler', 'deploy']);

console.log('\nSetting secrets …');
const vapid = await generateVapidKeys();
const setupToken = randomSetupToken();
const secrets: Record<string, string> = {
  SETUP_TOKEN: setupToken,
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
};
if (vapidSubject) secrets.VAPID_SUBJECT = vapidSubject;
// Secrets go through a private temp file that is always removed.
const dir = mkdtempSync(join(tmpdir(), 'stoppeklokke-'));
try {
  const file = join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  await run(['bunx', 'wrangler', 'secret', 'bulk', file]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`
Done. Next steps:

1. Register your first passkey:
   ${origin}/setup?token=${setupToken}

2. For CI/CD (push to main → deploy), set in GitHub → Settings → Secrets and variables → Actions:
   Secrets:   CLOUDFLARE_ACCOUNT_ID=${accountId}
              CLOUDFLARE_API_TOKEN=<create at https://dash.cloudflare.com/profile/api-tokens with
                Workers Scripts:Edit, D1:Edit, Account Settings:Read, and Zone → Workers Routes:Edit
                for your custom domain>
              BACKUP_PASSPHRASE=<long random passphrase; the weekly backup is encrypted with it>
   Variables: ${Object.entries(vars)
     .filter(([, v]) => v)
     .map(([k, v]) => `${k}=${v}`)
     .join('\n              ')}
`);

if (
  Bun.which('gh') &&
  ask(
    'Set the GitHub Variables and CLOUDFLARE_ACCOUNT_ID now with gh? (y/N)',
    'n',
  ).toLowerCase() === 'y'
) {
  for (const [k, v] of Object.entries(vars))
    if (v) await run(['gh', 'variable', 'set', k, '--body', v]);
  await run(['gh', 'secret', 'set', 'CLOUDFLARE_ACCOUNT_ID', '--body', accountId]);
  console.log(
    'Done. Remember to add CLOUDFLARE_API_TOKEN yourself: gh secret set CLOUDFLARE_API_TOKEN',
  );
}
