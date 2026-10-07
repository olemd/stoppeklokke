// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The self-hosted runtime: everything server.ts needs, without the network
 * listener, so tests can drive exactly the same code.
 *
 * It builds the same platform-agnostic `Ctx` as the Worker does, with
 * SQLite instead of D1, and tracks background work (webhooks, push) so a
 * shutdown can wait for it.
 */
import type { Database } from 'bun:sqlite';
import { parseConfig } from '../../core/config';
import { EventBus } from '../../core/events';
import { type Clock, consoleLogger, type Logger, systemClock } from '../../core/ports';
import { modules } from '../../modules';
import { createApp } from '../../modules/app';
import { runCron } from '../../modules/cron';
import { pushSenderFromConfig } from '../../modules/push/sender';
import type { Ctx } from '../../modules/types';
import { sqliteDb } from './sqlite';
import { createStaticHandler } from './static';

export interface RuntimeOptions {
  sqlite: Database;
  env: Record<string, string | undefined>;
  staticDir: string;
  clock?: Clock;
  log?: Logger;
}

export function createRuntime(opts: RuntimeOptions) {
  const parsed = parseConfig(opts.env);
  const db = sqliteDb(opts.sqlite);
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? consoleLogger;
  const push = pushSenderFromConfig(parsed.config, clock);
  const app = createApp(modules);
  const serveStatic = createStaticHandler(opts.staticDir);
  const pending = new Set<Promise<unknown>>();

  const scheduler = {
    waitUntil(p: Promise<unknown>) {
      const tracked = p.catch((err: unknown) =>
        log.error('background task failed', { err: String(err) }),
      );
      pending.add(tracked);
      void tracked.finally(() => pending.delete(tracked));
    },
  };

  function buildCtx(clientIp: string): Ctx {
    const events = new EventBus(scheduler, log);
    const ctx: Ctx = {
      db,
      config: parsed.config,
      configErrors: parsed.errors,
      clock,
      log,
      scheduler,
      events,
      push,
      clientIp: () => clientIp,
    };
    for (const m of modules) {
      const handler = m.onEvent;
      if (handler) events.on((e) => handler(e, ctx));
    }
    return ctx;
  }

  return {
    config: parsed.config,
    configErrors: parsed.errors,

    /** Handle one HTTP request; `clientIp` is resolved by the caller (socket or proxy). */
    async fetch(req: Request, clientIp: string): Promise<Response> {
      const { pathname } = new URL(req.url);
      if (!pathname.startsWith('/api/')) return serveStatic(req);
      const exec = { waitUntil: scheduler.waitUntil, passThroughOnException() {}, props: {} };
      return app.fetch(req, { ctx: buildCtx(clientIp) }, exec as never);
    },

    /** One run of the shared cron hook (§8.1). */
    async cron(): Promise<void> {
      await runCron(buildCtx('cron'));
    },

    /** Wait for in-flight background work (webhooks, push) before shutdown. */
    async drain(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
