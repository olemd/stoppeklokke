// SPDX-License-Identifier: AGPL-3.0-or-later
/** The single global stopwatch (§6). Edge cases live in entries/service.ts. */
import { createRoute, z } from '@hono/zod-openapi';
import { Entry, TimerPatch, TimerStart, TimerStop } from '../../shared/schemas';
import { loadLookup } from '../data/repo';
import {
  discardTimer,
  runningEntry,
  startTimer,
  stopTimer,
  toEntry,
  updateEntry,
} from '../entries/service';
import { conflict } from '../../core/errors';
import { body, json } from '../http';
import type { Module } from '../types';

export const timerModule: Module = {
  name: 'timer',
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['timer'],
        responses: { 200: json(Entry.nullable()) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const row = await runningEntry(ctx);
        return c.json(row ? toEntry(row, await loadLookup(ctx)) : null, 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/start',
        tags: ['timer'],
        request: body(TimerStart),
        responses: { 200: json(z.object({ entry: Entry, stopped: Entry.nullable() })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { started, stopped } = await startTimer(ctx, c.req.valid('json'));
        const lookup = await loadLookup(ctx);
        return c.json(
          { entry: toEntry(started, lookup), stopped: stopped ? toEntry(stopped, lookup) : null },
          200,
        );
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/stop',
        tags: ['timer'],
        request: body(TimerStop),
        responses: { 200: json(z.object({ entry: Entry.nullable(), discarded: z.boolean() })) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { entry, discarded } = await stopTimer(ctx, c.req.valid('json'));
        return c.json(
          { entry: entry ? toEntry(entry, await loadLookup(ctx)) : null, discarded },
          200,
        );
      },
    );

    app.openapi(
      createRoute({
        method: 'patch',
        path: '/',
        tags: ['timer'],
        request: body(TimerPatch),
        responses: { 200: json(Entry) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const running = await runningEntry(ctx);
        if (!running) throw conflict('no_timer', 'No timer is running');
        const row = await updateEntry(ctx, running, c.req.valid('json'));
        return c.json(toEntry(row, await loadLookup(ctx)), 200);
      },
    );

    app.openapi(
      createRoute({
        method: 'post',
        path: '/discard',
        tags: ['timer'],
        responses: { 200: json(z.object({ ok: z.literal(true) })) },
      }),
      async (c) => {
        await discardTimer(c.env.ctx);
        return c.json({ ok: true as const }, 200);
      },
    );
  },
};
