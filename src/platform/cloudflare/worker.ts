// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Worker entry point: builds a platform-agnostic `Ctx` from the Cloudflare
 * env and hands requests to the Hono app and cron runs to the modules.
 */
import { parseConfig, type ParsedConfig } from '../../core/config';
import { EventBus } from '../../core/events';
import { consoleLogger, systemClock } from '../../core/ports';
import { createApp } from '../../modules/app';
import { modules } from '../../modules';
import { runCron } from '../../modules/cron';
import type { Ctx } from '../../modules/types';
import { d1Db } from './d1';
import { pushSender } from './push';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  [key: string]: unknown;
}

const app = createApp(modules);

// Config is parsed once per isolate; env does not change within an isolate.
let parsed: ParsedConfig | null = null;

export function buildCtx(env: Env, exec: { waitUntil(p: Promise<unknown>): void }): Ctx {
  parsed ??= parseConfig(env);
  const scheduler = { waitUntil: (p: Promise<unknown>) => exec.waitUntil(p) };
  const events = new EventBus(scheduler, consoleLogger);
  const ctx: Ctx = {
    db: d1Db(env.DB),
    config: parsed.config,
    configErrors: parsed.errors,
    clock: systemClock,
    log: consoleLogger,
    scheduler,
    events,
    push: pushSender(parsed.config),
  };
  for (const m of modules) {
    const handler = m.onEvent;
    if (handler) events.on((e) => handler(e, ctx));
  }
  return ctx;
}

export default {
  async fetch(request, env, exec) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return app.fetch(request, { ctx: buildCtx(env, exec) }, exec);
  },
  async scheduled(_controller, env, exec) {
    await runCron(buildCtx(env, exec));
  },
} satisfies ExportedHandler<Env>;
