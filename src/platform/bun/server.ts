// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Self-hosted entry point: `bun dist/server/server.js` (or
 * `bun src/platform/bun/server.ts` in development). See docs/self-hosting.md.
 *
 * One process serves the API and the PWA, runs migrations at startup and the
 * cron hook every 5 minutes (the Worker's `*\/5 * * * *` trigger). Put it
 * behind a TLS reverse proxy: passkeys and the __Host- cookie require HTTPS.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { consoleLogger } from '../../core/ports';
import { clientIpFrom, readServerEnv } from './env';
import { applyMigrations } from './migrate';
import { createRuntime } from './runtime';
import { openDatabase } from './sqlite';

const CRON_INTERVAL_MS = 5 * 60 * 1000;
const log = consoleLogger;
const env = process.env as Record<string, string | undefined>;
const server = readServerEnv(env);

if (server.databasePath !== ':memory:')
  mkdirSync(dirname(server.databasePath), { recursive: true });
const sqlite = openDatabase(server.databasePath);
const applied = applyMigrations(sqlite, server.migrationsDir);
if (applied.length) log.info('migrations applied', { applied });

const runtime = createRuntime({ sqlite, env, staticDir: server.staticDir, log });
if (runtime.configErrors.length)
  log.warn('configuration problems', { errors: runtime.configErrors });

const http = Bun.serve({
  port: server.port,
  hostname: server.host,
  fetch: (req, srv) =>
    runtime.fetch(req, clientIpFrom(req, srv.requestIP(req)?.address, server.trustProxy)),
});
log.info('listening', {
  url: `http://${http.hostname}:${http.port}`,
  origin: runtime.config.ORIGIN,
});

// Cron: aligned to 5-minute boundaries like Cloudflare's trigger; never overlapping.
let cronRunning = false;
const tick = async () => {
  if (cronRunning) return;
  cronRunning = true;
  try {
    await runtime.cron();
  } catch (err) {
    log.error('cron failed', { err: String(err) });
  } finally {
    cronRunning = false;
  }
};
let interval: ReturnType<typeof setInterval> | undefined;
const timeout = setTimeout(
  () => {
    void tick();
    interval = setInterval(() => void tick(), CRON_INTERVAL_MS);
  },
  CRON_INTERVAL_MS - (Date.now() % CRON_INTERVAL_MS),
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  clearTimeout(timeout);
  if (interval) clearInterval(interval);
  await http.stop();
  await runtime.drain();
  sqlite.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
