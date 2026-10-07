// SPDX-License-Identifier: AGPL-3.0-or-later
/** GET/PATCH /api/settings (§4.3). Values are validated server-side. */
import { createRoute, z } from '@hono/zod-openapi';
import { badRequest } from '../../core/errors';
import { SETTING_KEYS, settingSchemas, type SettingKey } from '../../core/settings/defs';
import { catalogs } from '../../shared/i18n/catalogs.generated';
import { SettingsPatch } from '../../shared/schemas';
import { getWorkspace, loadSettings } from '../data/repo';
import { body, json } from '../http';
import { planRateChange, runWithPlan } from '../rates/change';
import type { Stmt } from '../../core/ports';
import type { Module } from '../types';

const SettingsOut = z.record(z.string(), z.unknown());

/** Upsert statements for a validated settings patch. */
export function settingsStatements(patch: Partial<Record<SettingKey, unknown>>): Stmt[] {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  return entries.map(([key, value]) => ({
    sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    params: [key, JSON.stringify(value)],
  }));
}

export const settingsModule: Module = {
  name: 'settings',
  routes(app) {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/',
        tags: ['settings'],
        responses: { 200: json(SettingsOut) },
      }),
      async (c) => c.json({ ...(await loadSettings(c.env.ctx)) }, 200),
    );

    app.openapi(
      createRoute({
        method: 'patch',
        path: '/',
        tags: ['settings'],
        request: body(SettingsPatch),
        responses: { 200: json(SettingsOut) },
      }),
      async (c) => {
        const ctx = c.env.ctx;
        const { rate_change, ...input } = c.req.valid('json');
        const patch: Partial<Record<SettingKey, unknown>> = {};
        for (const key of SETTING_KEYS) {
          if (!(key in input)) continue;
          const value = (input as Record<string, unknown>)[key];
          const parsed = settingSchemas[key].safeParse(value);
          if (!parsed.success) {
            throw badRequest('invalid_setting', `${key}: ${parsed.error.issues[0]?.message}`, {
              key,
            });
          }
          patch[key] = parsed.data;
        }
        if (patch.locale !== undefined && !(String(patch.locale) in catalogs)) {
          throw badRequest('invalid_setting', 'locale: no such translation', { key: 'locale' });
        }
        if (patch.active_workspace_id != null) {
          const w = await getWorkspace(ctx, patch.active_workspace_id as number);
          if (!w || w.archived)
            throw badRequest(
              'invalid_setting',
              'active_workspace_id: unknown or archived workspace',
            );
        }
        const before = await loadSettings(ctx);
        const plan = await planRateChange(
          ctx,
          {
            level: 'default',
            id: null,
            rateChanged:
              patch.default_hourly_rate !== undefined &&
              patch.default_hourly_rate !== before.default_hourly_rate,
            currencyChanged: patch.currency !== undefined && patch.currency !== before.currency,
          },
          rate_change,
        );
        const result = await runWithPlan(ctx, plan, settingsStatements(patch), {
          level: 'default',
          id: null,
        });
        return c.json({ ...(await loadSettings(ctx)), rate_change_result: result }, 200);
      },
    );
  },
};
