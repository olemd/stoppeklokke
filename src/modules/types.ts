// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The module contract (§15.1). Every feature is a folder in src/modules/
 * exporting a `Module`; they are registered explicitly in src/modules/index.ts.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { z } from 'zod';
import type { AppConfig } from '../core/config';
import type { DomainEvent, EventBus } from '../core/events';
import type { Clock, Db, Logger, PushSender, Scheduler } from '../core/ports';

/** Everything a request or cron run needs; built per invocation by the platform layer. */
export interface Ctx {
  db: Db;
  config: AppConfig;
  configErrors: string[];
  clock: Clock;
  log: Logger;
  scheduler: Scheduler;
  events: EventBus;
  /** null when VAPID keys are not configured. */
  push: PushSender | null;
  /**
   * The client's IP address for a request, as the platform knows it (used by
   * the auth rate limit). Platform-specific: Cloudflare sets a header it
   * controls; a self-hosted server uses the socket or a trusted proxy header.
   */
  clientIp(req: Request): string;
}

export type AuthInfo =
  | { kind: 'session'; idHash: string; expiresAt: number; mustRegister: boolean }
  | { kind: 'token'; tokenId: number; scope: 'read' | 'write' };

export interface AppEnv {
  Bindings: { ctx: Ctx };
  Variables: { auth: AuthInfo | null };
}

export type Router = OpenAPIHono<AppEnv>;

export interface SettingDef<T = unknown> {
  key: string;
  schema: z.ZodType<T>;
  default: T;
  /** Can be overridden per workspace (the **W** settings in §4.3). */
  workspace?: boolean;
}

/** One collection in the full data export/import (§9.1). */
export interface ExportCollection {
  name: string;
  /** Export order; collections are exported and imported in ascending order (dependencies first). */
  order: number;
  /** Return up to `limit` rows after `cursor` (opaque). `next` is null when done. */
  page(
    ctx: Ctx,
    cursor: string | null,
    limit: number,
  ): Promise<{ rows: unknown[]; next: string | null }>;
  /** Insert rows keeping their original IDs. Must be a single D1 batch. */
  import(ctx: Ctx, rows: unknown[]): Promise<number>;
  count(ctx: Ctx): Promise<number>;
  /** Delete everything this collection imported ("wipe imported data"). */
  wipe?(ctx: Ctx): Promise<void>;
}

export interface Module {
  name: string;
  /** Routes, mounted under /api/<name> unless `mountPath` says otherwise. */
  routes?: (app: Router) => void;
  mountPath?: string;
  /** Paths (relative to the mount, e.g. '/login/options') reachable without auth. */
  publicPaths?: string[];
  settings?: SettingDef[];
  /** Path of this module's SQL migration in migrations/ (wrangler has one migrations dir). */
  migrations?: string;
  onEvent?: (e: DomainEvent, ctx: Ctx) => Promise<void>;
  /** Run from the single shared cron trigger (§8.1). */
  cron?: (ctx: Ctx) => Promise<void>;
  exportCollections?: ExportCollection[];
}
