// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operator recovery (§5.4): deletes all passkeys, sessions and recovery codes
 * in the remote D1 database after a typed confirmation. Time data is untouched.
 *
 * This does not weaken security: anyone with access to the Cloudflare account
 * already owns the data. Afterwards, set a new SETUP_TOKEN and visit /setup.
 */
import { confirmTyped, randomSetupToken, wrangler } from './lib';

const local = process.argv.includes('--local');
console.log(
  `This deletes ALL passkeys, sessions and recovery codes in the ${local ? 'LOCAL' : 'REMOTE'} database.\nYour time data is not touched.`,
);
if (!confirmTyped('reset auth', 'Are you sure?')) {
  console.log('Aborted.');
  process.exit(1);
}

await Bun.spawn(['bun', 'run', 'render-config'], { stdio: ['inherit', 'inherit', 'inherit'] })
  .exited;
await wrangler([
  'd1',
  'execute',
  'DB',
  local ? '--local' : '--remote',
  '--command',
  'DELETE FROM passkeys; DELETE FROM sessions; DELETE FROM recovery_codes; DELETE FROM auth_challenges;',
]);

const token = randomSetupToken();
console.log(`
Auth has been reset. Next:

1. Set a new setup token (the old one may be known to others):
   echo '${token}' | bunx wrangler secret put SETUP_TOKEN
2. Visit <ORIGIN>/setup?token=${token} and register a new passkey.
`);
