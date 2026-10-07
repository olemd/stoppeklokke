// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Authentication for /api/* (§5.5): every path requires a valid session or an
 * API token, except the public paths that modules declare (login, setup,
 * health). Bearer tokens are resolved by the tokens module's verifier.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, AuthInfo, Ctx } from '../types';
import { readSession } from './session';

export type BearerVerifier = (ctx: Ctx, token: string) => Promise<AuthInfo | null>;

let bearerVerifier: BearerVerifier | null = null;

/** Called once by the tokens module at registration time. */
export function setBearerVerifier(v: BearerVerifier) {
  bearerVerifier = v;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const MUST_REGISTER_ALLOWED = new Set([
  '/api/auth/register/options',
  '/api/auth/register/verify',
  '/api/auth/logout',
]);

export function authenticate(publicPaths: Set<string>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authz = c.req.header('authorization');
    let auth: AuthInfo | null = null;
    if (authz?.startsWith('Bearer ')) {
      auth = bearerVerifier ? await bearerVerifier(c.env.ctx, authz.slice(7).trim()) : null;
      if (!auth) return c.json({ error: 'unauthorized', message: 'Invalid API token' }, 401);
      if (auth.kind === 'token' && auth.scope === 'read' && !READ_METHODS.has(c.req.method)) {
        return c.json({ error: 'forbidden', message: 'Token has read-only scope' }, 403);
      }
    } else {
      const s = await readSession(c);
      if (s) auth = { kind: 'session', ...s };
    }
    c.set('auth', auth);
    const isPublic = publicPaths.has(c.req.path);
    if (!auth && !isPublic) {
      return c.json({ error: 'unauthorized', message: 'Login required' }, 401);
    }
    // A recovery-code session may only register a new passkey (or log out).
    if (
      auth?.kind === 'session' &&
      auth.mustRegister &&
      !isPublic &&
      !MUST_REGISTER_ALLOWED.has(c.req.path)
    ) {
      return c.json({ error: 'must_register', message: 'Register a new passkey to continue' }, 403);
    }
    await next();
  };
}
