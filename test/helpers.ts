// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Test harness: calls the Hono app directly with a controllable clock, so
 * time-dependent rules (timers, sessions, locks) are deterministic.
 */
import { env } from 'cloudflare:test';
import { parseConfig } from '../src/core/config';
import { randomToken, sha256Hex } from '../src/core/crypto';
import { EventBus, type DomainEvent } from '../src/core/events';
import type { Clock, Logger, PushSender } from '../src/core/ports';
import { createApp } from '../src/modules/app';
import { modules } from '../src/modules';
import type { Ctx } from '../src/modules/types';
import { d1Db } from '../src/platform/cloudflare/d1';

export const ORIGIN = 'https://stoppeklokke.test';
export const db = d1Db(env.DB);

export class TestClock implements Clock {
  constructor(public t = 1_790_000_000) {}
  now() {
    return this.t;
  }
  advance(seconds: number) {
    this.t += seconds;
  }
}

export const quietLogger: Logger = { info() {}, warn() {}, error() {} };

export interface Harness {
  ctx: Ctx;
  clock: TestClock;
  events: DomainEvent[];
  pending: Promise<unknown>[];
  /** Fetch with cookie jar + same-origin headers. */
  fetch(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  /** Fetch and parse JSON, asserting nothing about status. */
  json<T = any>(
    path: string,
    init?: RequestInit & { json?: unknown },
  ): Promise<{ status: number; body: T }>;
  cookie: string | null;
  settle(): Promise<void>;
}

export function harness(opts: { push?: PushSender | null; now?: number } = {}): Harness {
  const clock = new TestClock(opts.now);
  const pending: Promise<unknown>[] = [];
  const scheduler = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const bus = new EventBus(scheduler, quietLogger);
  const parsed = parseConfig(env as unknown as Record<string, unknown>);
  const ctx: Ctx = {
    db,
    config: parsed.config,
    configErrors: parsed.errors,
    clock,
    log: quietLogger,
    scheduler,
    events: bus,
    push: opts.push ?? null,
  };
  const events: DomainEvent[] = [];
  bus.on(async (e) => void events.push(e));
  for (const m of modules) {
    const h = m.onEvent;
    if (h) bus.on((e) => h(e, ctx));
  }
  const app = createApp(modules);
  const h: Harness = {
    ctx,
    clock,
    events,
    pending,
    cookie: null,
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has('origin')) headers.set('origin', ORIGIN);
      if (h.cookie && !headers.has('cookie')) headers.set('cookie', h.cookie);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(init.json);
      }
      const res = await app.fetch(new Request(ORIGIN + path, { ...init, headers, body }), { ctx }, {
        waitUntil: scheduler.waitUntil,
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext);
      const set = res.headers.get('set-cookie');
      if (set) {
        const m = set.match(/__Host-session=([^;]*)/);
        if (m) h.cookie = m[1] ? `__Host-session=${m[1]}` : null;
      }
      return res;
    },
    async json(path, init) {
      const res = await h.fetch(path, init);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async settle() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
  return h;
}

/** Delete all rows from all app tables (FK-safe order). */
export async function resetDb() {
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
  );
  await env.DB.exec('PRAGMA defer_foreign_keys = on');
  const order = [
    'notification_log',
    'time_entries',
    'period_locks',
    'projects',
    'clients',
    'workspaces',
  ];
  const names = tables.map((t) => t.name);
  const sorted = [
    ...order.filter((n) => names.includes(n)),
    ...names.filter((n) => !order.includes(n)),
  ];
  await env.DB.batch(sorted.map((n) => env.DB.prepare(`DELETE FROM "${n}"`)));
}

/** A harness with a valid session (inserted directly; the auth flow has its own tests). */
export async function authed(opts: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = harness(opts);
  const token = randomToken(32);
  await db.run(
    'INSERT INTO sessions (id_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)',
    await sha256Hex(token),
    h.clock.now(),
    h.clock.now() + 30 * 86400,
    'test',
  );
  h.cookie = `__Host-session=${token}`;
  return h;
}

/** POST/PATCH/DELETE shorthands that assert the expected status. */
export async function call<T = any>(
  h: Harness,
  method: string,
  path: string,
  json?: unknown,
  expectStatus?: number,
): Promise<T> {
  const r = await h.json<T>(path, { method, ...(json !== undefined ? { json } : {}) });
  if (expectStatus !== undefined && r.status !== expectStatus) {
    throw new Error(
      `${method} ${path} → ${r.status} (expected ${expectStatus}): ${JSON.stringify(r.body)}`,
    );
  }
  return r.body;
}

export const HOUR = 3600;
