// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sessions (§5.3): 32 random bytes in a `__Host-session` cookie; the database
 * stores only SHA-256(token). 30-day lifetime, renewed on use when fewer than
 * 15 days remain, so an installed mobile PWA does not keep asking for login.
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { randomToken, sha256Hex } from '../../core/crypto';
import type { AppEnv, Ctx } from '../types';

export const SESSION_COOKIE = '__Host-session';
export const SESSION_TTL = 30 * 86400;
export const SESSION_RENEW_BELOW = 15 * 86400;

export interface SessionInfo {
  idHash: string;
  expiresAt: number;
  mustRegister: boolean;
}

function writeCookie(c: Context<AppEnv>, token: string, expiresAt: number) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    expires: new Date(expiresAt * 1000),
  });
}

/** Create a session and set the cookie. `mustRegister` restricts it to passkey registration. */
export async function createSession(c: Context<AppEnv>, mustRegister = false): Promise<void> {
  const { db, clock } = c.env.ctx;
  const token = randomToken(32);
  const now = clock.now();
  const expiresAt = now + SESSION_TTL;
  await db.run(
    'INSERT INTO sessions (id_hash, created_at, expires_at, user_agent, must_register) VALUES (?, ?, ?, ?, ?)',
    await sha256Hex(token),
    now,
    expiresAt,
    (c.req.header('user-agent') ?? '').slice(0, 300),
    mustRegister ? 1 : 0,
  );
  writeCookie(c, token, expiresAt);
}

/** Validates the cookie; renews it when fewer than 15 days remain. */
export async function readSession(c: Context<AppEnv>): Promise<SessionInfo | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const { db, clock } = c.env.ctx;
  const idHash = await sha256Hex(token);
  const row = await db.first<{ expires_at: number; must_register: number }>(
    'SELECT expires_at, must_register FROM sessions WHERE id_hash = ?',
    idHash,
  );
  const now = clock.now();
  if (!row || row.expires_at <= now) return null;
  const mustRegister = row.must_register === 1;
  if (row.expires_at - now < SESSION_RENEW_BELOW) {
    const expiresAt = now + SESSION_TTL;
    await db.run('UPDATE sessions SET expires_at = ? WHERE id_hash = ?', expiresAt, idHash);
    writeCookie(c, token, expiresAt);
    return { idHash, expiresAt, mustRegister };
  }
  return { idHash, expiresAt: row.expires_at, mustRegister };
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

export async function purgeExpired(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.batch([
    { sql: 'DELETE FROM sessions WHERE expires_at <= ?', params: [now] },
    { sql: 'DELETE FROM auth_challenges WHERE expires_at <= ?', params: [now] },
    { sql: 'DELETE FROM auth_attempts WHERE at <= ?', params: [now - 600] },
  ]);
}
