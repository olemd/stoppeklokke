// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Builds the Hono app from the module list. Platform-agnostic: the platform
 * layer passes a fully built `Ctx` as the `ctx` binding on every request.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { HttpError } from '../core/errors';
import { authenticate } from './auth/middleware';
import type { AppEnv, Module, Router } from './types';

/** Uniform 400 for zod validation failures on every route. */
export function newRouter(): Router {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: 'validation',
            message: 'Invalid request',
            issues: result.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          400,
        );
      }
    },
  });
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * §5.5: state-changing requests authenticated by cookie must carry an Origin
 * equal to ORIGIN (on top of SameSite=Strict). Bearer-token requests carry no
 * ambient credentials and are exempt.
 */
const originCheck: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (STATE_CHANGING.has(c.req.method) && !c.req.header('authorization')?.startsWith('Bearer ')) {
    if (c.req.header('origin') !== c.env.ctx.config.ORIGIN) {
      return c.json({ error: 'bad_origin', message: 'Cross-origin request rejected' }, 403);
    }
  }
  await next();
};

export function createApp(modules: Module[]): Router {
  const app = newRouter();

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
      strictTransportSecurity: 'max-age=63072000; includeSubDomains',
      referrerPolicy: 'same-origin',
      xContentTypeOptions: 'nosniff',
      xFrameOptions: 'DENY',
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use('/api/*', async (c, next) => {
    // API responses are per-user and must never be cached by intermediaries.
    await next();
    if (!c.res.headers.has('cache-control')) c.res.headers.set('cache-control', 'no-store');
  });
  app.use('/api/*', originCheck);

  const publicPaths = new Set<string>();
  for (const m of modules) {
    const base = m.mountPath ?? `/api/${m.name}`;
    for (const p of m.publicPaths ?? []) publicPaths.add(base + (p === '/' ? '' : p));
  }
  app.use('/api/*', authenticate(publicPaths));

  for (const m of modules) {
    if (!m.routes) continue;
    const r = newRouter();
    m.routes(r);
    app.route(m.mountPath ?? `/api/${m.name}`, r);
  }

  app.notFound((c) => c.json({ error: 'not_found', message: 'Not found' }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.code, message: err.message, ...err.details }, err.status);
    }
    c.env.ctx.log.error('unhandled error', { err: String(err), stack: (err as Error).stack });
    return c.json({ error: 'internal', message: 'Internal error' }, 500);
  });

  return app;
}
