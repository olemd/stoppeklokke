// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Authentication module (§5): passkeys only (WebAuthn, discoverable, user
 * verification required), recovery codes, sessions.
 *
 * - First passkey: /setup?token=SETUP_TOKEN, only while no passkey exists.
 * - More passkeys: from settings, with a logged-in session.
 * - Recovery code: one login that may only register a new passkey.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Context } from 'hono';
import { fromBase64Url, randomToken, timingSafeEqual } from '../../core/crypto';
import { HttpError, badRequest, conflict, notFound } from '../../core/errors';
import type { AppEnv, Ctx, Module, Router } from '../types';
import { checkRateLimit } from './ratelimit';
import { RECOVERY_CODE_COUNT, generateRecoveryCode, hashRecoveryCode } from './recovery';
import { clearSessionCookie, createSession, purgeExpired } from './session';

const CHALLENGE_TTL = 300;

const json = <T extends z.ZodType>(schema: T, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

const Ok = z.object({ ok: z.literal(true) });
const WebAuthnJSON = z.record(z.string(), z.unknown());
const PasskeySchema = z.object({
  id: z.string(),
  label: z.string(),
  created_at: z.number(),
  last_used_at: z.number().nullable(),
});

async function passkeyCount(ctx: Ctx): Promise<number> {
  const r = await ctx.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys');
  return r?.n ?? 0;
}

async function storeChallenge(ctx: Ctx, challenge: string, kind: string) {
  await ctx.db.run(
    'INSERT INTO auth_challenges (challenge, kind, expires_at) VALUES (?, ?, ?)',
    challenge,
    kind,
    ctx.clock.now() + CHALLENGE_TTL,
  );
}

/** Single-use: only the request whose DELETE removes the row may proceed. */
function consumeChallenge(ctx: Ctx, kind: string) {
  return async (challenge: string) => {
    const r = await ctx.db.run(
      'DELETE FROM auth_challenges WHERE challenge = ? AND kind = ? AND expires_at > ?',
      challenge,
      kind,
      ctx.clock.now(),
    );
    return r.changes === 1;
  };
}

/** Stable random WebAuthn user handle for the single user, created on first use. */
async function userHandle(ctx: Ctx): Promise<Uint8Array<ArrayBuffer>> {
  await ctx.db.run(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('webauthn_user_id', ?)",
    JSON.stringify(randomToken(16)),
  );
  const row = await ctx.db.first<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'webauthn_user_id'",
  );
  return fromBase64Url(JSON.parse(row!.value) as string);
}

function setupTokenValid(ctx: Ctx, token: string | undefined): boolean {
  const expected = ctx.config.SETUP_TOKEN;
  return !!expected && !!token && timingSafeEqual(token, expected);
}

/**
 * Registration is allowed either as first-time setup (no passkeys yet + valid
 * SETUP_TOKEN) or with a session (adding a passkey / after recovery).
 */
async function registrationMode(
  c: Context<AppEnv>,
  setupToken: string | undefined,
): Promise<'setup' | 'add'> {
  const ctx = c.env.ctx;
  if (c.get('auth')?.kind === 'session') return 'add';
  if ((await passkeyCount(ctx)) > 0)
    throw new HttpError(403, 'setup_disabled', 'Setup is disabled');
  if (!setupTokenValid(ctx, setupToken))
    throw new HttpError(403, 'bad_setup_token', 'Invalid setup token');
  return 'setup';
}

function routes(app: Router) {
  // Public: tells the UI whether to show setup, login or the app.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/status',
      tags: ['auth'],
      responses: {
        200: json(
          z.object({
            setup_required: z.boolean(),
            authenticated: z.boolean(),
            must_register: z.boolean(),
          }),
        ),
      },
    }),
    async (c) => {
      const auth = c.get('auth');
      return c.json(
        {
          setup_required: (await passkeyCount(c.env.ctx)) === 0,
          authenticated: !!auth,
          must_register: auth?.kind === 'session' && auth.mustRegister,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/register/options',
      tags: ['auth'],
      request: body(z.object({ setup_token: z.string().optional() })),
      responses: { 200: json(WebAuthnJSON) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const { setup_token } = c.req.valid('json');
      await registrationMode(c, setup_token);
      const existing = await ctx.db.all<{ id: string; transports: string | null }>(
        'SELECT id, transports FROM passkeys',
      );
      const options = await generateRegistrationOptions({
        rpName: ctx.config.RP_NAME,
        rpID: ctx.config.RP_ID,
        userName: ctx.config.RP_NAME,
        userDisplayName: ctx.config.RP_NAME,
        userID: await userHandle(ctx),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: existing.map((p) => ({
          id: p.id,
          transports: p.transports
            ? (JSON.parse(p.transports) as AuthenticatorTransport[])
            : undefined,
        })),
      });
      await storeChallenge(ctx, options.challenge, 'register');
      return c.json(options as unknown as Record<string, unknown>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/register/verify',
      tags: ['auth'],
      request: body(
        z.object({
          response: WebAuthnJSON,
          label: z.string().trim().min(1).max(100).default('Passkey'),
          setup_token: z.string().optional(),
        }),
      ),
      responses: {
        200: json(
          z.object({ ok: z.literal(true), recovery_codes: z.array(z.string()).optional() }),
        ),
      },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      const { response, label, setup_token } = c.req.valid('json');
      await checkRateLimit(c);
      const mode = await registrationMode(c, setup_token);
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: response as unknown as RegistrationResponseJSON,
          expectedChallenge: consumeChallenge(ctx, 'register'),
          expectedOrigin: ctx.config.ORIGIN,
          expectedRPID: ctx.config.RP_ID,
          requireUserVerification: true,
        });
      } catch (err) {
        throw badRequest('webauthn_failed', String((err as Error).message ?? err));
      }
      if (!verification.verified) throw badRequest('webauthn_failed', 'Registration not verified');
      const { credential } = verification.registrationInfo;
      const now = ctx.clock.now();
      const params = [
        credential.id,
        credential.publicKey,
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        label,
        now,
      ];

      if (mode === 'setup') {
        // One atomic batch: the passkey is only inserted if none exists (two
        // concurrent setups cannot both succeed), and the recovery codes are
        // only written if that insert happened.
        const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
        const hashes = await Promise.all(codes.map(hashRecoveryCode));
        const ours = 'EXISTS (SELECT 1 FROM passkeys WHERE id = ?)';
        const [insert] = await ctx.db.batch([
          {
            sql: `INSERT INTO passkeys (id, public_key, counter, transports, label, created_at)
                  SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM passkeys)`,
            params,
          },
          { sql: `DELETE FROM recovery_codes WHERE ${ours}`, params: [credential.id] },
          ...hashes.map((h) => ({
            sql: `INSERT INTO recovery_codes (code_hash) SELECT ? WHERE ${ours}`,
            params: [h, credential.id],
          })),
        ]);
        if (insert?.changes !== 1) throw new HttpError(403, 'setup_disabled', 'Setup is disabled');
        await createSession(c);
        return c.json({ ok: true as const, recovery_codes: codes }, 200);
      }

      const auth = c.get('auth');
      await ctx.db.batch([
        {
          sql: 'INSERT INTO passkeys (id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          params,
        },
        // Registering a passkey completes the recovery flow.
        ...(auth?.kind === 'session' && auth.mustRegister
          ? [
              {
                sql: 'UPDATE sessions SET must_register = 0 WHERE id_hash = ?',
                params: [auth.idHash],
              },
            ]
          : []),
      ]);
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/login/options',
      tags: ['auth'],
      responses: { 200: json(WebAuthnJSON) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      // Opportunistic cleanup of expired rows; cheap, set-based.
      ctx.scheduler.waitUntil(purgeExpired(ctx));
      const options = await generateAuthenticationOptions({
        rpID: ctx.config.RP_ID,
        userVerification: 'required',
      });
      await storeChallenge(ctx, options.challenge, 'login');
      return c.json(options as unknown as Record<string, unknown>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/login/verify',
      tags: ['auth'],
      request: body(z.object({ response: WebAuthnJSON })),
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      await checkRateLimit(c);
      const response = c.req.valid('json').response as unknown as AuthenticationResponseJSON;
      const pk = await ctx.db.first<{
        id: string;
        public_key: ArrayBuffer;
        counter: number;
        transports: string | null;
      }>(
        'SELECT id, public_key, counter, transports FROM passkeys WHERE id = ?',
        String(response.id),
      );
      if (!pk) throw new HttpError(401, 'unknown_passkey', 'This passkey is not registered here');
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: consumeChallenge(ctx, 'login'),
          expectedOrigin: ctx.config.ORIGIN,
          expectedRPID: ctx.config.RP_ID,
          requireUserVerification: true,
          credential: {
            id: pk.id,
            publicKey: new Uint8Array(pk.public_key),
            counter: pk.counter,
            transports: pk.transports
              ? (JSON.parse(pk.transports) as AuthenticatorTransport[])
              : undefined,
          },
        });
      } catch (err) {
        throw new HttpError(401, 'webauthn_failed', String((err as Error).message ?? err));
      }
      if (!verification.verified) throw new HttpError(401, 'webauthn_failed', 'Login not verified');
      await ctx.db.run(
        'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?',
        verification.authenticationInfo.newCounter,
        ctx.clock.now(),
        pk.id,
      );
      await createSession(c);
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/recovery',
      tags: ['auth'],
      request: body(z.object({ code: z.string().min(1).max(100) })),
      responses: { 200: json(z.object({ ok: z.literal(true), must_register: z.literal(true) })) },
    }),
    async (c) => {
      const ctx = c.env.ctx;
      await checkRateLimit(c);
      const hash = await hashRecoveryCode(c.req.valid('json').code);
      const r = await ctx.db.run(
        'UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL',
        ctx.clock.now(),
        hash,
      );
      if (r.changes !== 1)
        throw new HttpError(401, 'bad_recovery_code', 'Invalid or used recovery code');
      await createSession(c, true);
      return c.json({ ok: true as const, must_register: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({ method: 'post', path: '/logout', tags: ['auth'], responses: { 200: json(Ok) } }),
    async (c) => {
      const auth = c.get('auth');
      if (auth?.kind === 'session') {
        await c.env.ctx.db.run('DELETE FROM sessions WHERE id_hash = ?', auth.idHash);
      }
      clearSessionCookie(c);
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/logout-all',
      tags: ['auth'],
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      await c.env.ctx.db.run('DELETE FROM sessions');
      clearSessionCookie(c);
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/passkeys',
      tags: ['auth'],
      responses: { 200: json(z.array(PasskeySchema)) },
    }),
    async (c) => {
      const rows = await c.env.ctx.db.all<z.infer<typeof PasskeySchema>>(
        'SELECT id, label, created_at, last_used_at FROM passkeys ORDER BY created_at',
      );
      return c.json(rows, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/passkeys/{id}',
      tags: ['auth'],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(Ok) },
    }),
    async (c) => {
      const { db } = c.env.ctx;
      const { id } = c.req.valid('param');
      // Never delete the last passkey: that would lock the owner out (§5.4
      // reset-auth exists for the operator, but should not be needed).
      const r = await db.run(
        'DELETE FROM passkeys WHERE id = ? AND (SELECT COUNT(*) FROM passkeys) > 1',
        id,
      );
      if (r.changes === 0) {
        const exists = await db.first('SELECT 1 FROM passkeys WHERE id = ?', id);
        if (!exists) throw notFound();
        throw conflict('last_passkey', 'Cannot delete the last passkey');
      }
      return c.json({ ok: true as const }, 200);
    },
  );
}

export const authModule: Module = {
  name: 'auth',
  routes,
  migrations: 'migrations/0002_auth.sql',
  publicPaths: [
    '/status',
    '/register/options',
    '/register/verify',
    '/login/options',
    '/login/verify',
    '/recovery',
    '/logout',
  ],
};
