// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Auth rate limiting (§5.5): at most 10 attempts per 10 minutes per IP, kept
 * in D1. Counting and recording happen in one batch so the check is cheap.
 */
import type { Context } from 'hono';
import { HttpError } from '../../core/errors';
import type { AppEnv } from '../types';

export const RATE_LIMIT = 10;
export const RATE_WINDOW = 600;

/** Records one attempt and throws 429 if the IP is over the limit. */
export async function checkRateLimit(c: Context<AppEnv>): Promise<void> {
  const { db, clock } = c.env.ctx;
  const ip = c.env.ctx.clientIp(c.req.raw);
  const now = clock.now();
  const [, , count] = await db.batch([
    { sql: 'DELETE FROM auth_attempts WHERE at <= ?', params: [now - RATE_WINDOW] },
    { sql: 'INSERT INTO auth_attempts (ip, at) VALUES (?, ?)', params: [ip, now] },
    { sql: 'SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ?', params: [ip] },
  ]);
  const n = Number((count?.rows[0] as { n: number } | undefined)?.n ?? 0);
  if (n > RATE_LIMIT) {
    throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
  }
}
