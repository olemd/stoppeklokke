// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Self-hosting settings that are not part of the app config (src/core/config.ts):
 * where things live and how the server listens. Read from the environment
 * (Bun loads `.env` automatically).
 */
export interface ServerEnv {
  port: number;
  host: string;
  databasePath: string;
  staticDir: string;
  migrationsDir: string;
  /**
   * Trust the right-most X-Forwarded-For entry as the client IP. Only enable
   * behind a reverse proxy that sets it (Caddy, nginx); otherwise clients
   * could spoof their IP and dodge the auth rate limit.
   */
  trustProxy: boolean;
}

export function readServerEnv(env: Record<string, string | undefined>): ServerEnv {
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    databasePath: env.DATABASE_PATH ?? './data/stoppeklokke.sqlite',
    staticDir: env.STATIC_DIR ?? './dist/web',
    migrationsDir: env.MIGRATIONS_DIR ?? './migrations',
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
  };
}

/** Client IP: the socket address, or the proxy's X-Forwarded-For entry when trusted. */
export function clientIpFrom(
  req: Request,
  socketIp: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    // The right-most entry is the one our proxy appended; earlier ones are client-supplied.
    const xff = req.headers.get('x-forwarded-for');
    const last = xff
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    if (last) return last;
  }
  return socketIp ?? 'unknown';
}
