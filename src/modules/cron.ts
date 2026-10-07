// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The single shared cron trigger (§8.1). Each module's cron hook runs in turn;
 * one failing module never blocks the others.
 */
import { modules } from '.';
import type { Ctx } from './types';

export async function runCron(ctx: Ctx): Promise<void> {
  for (const m of modules) {
    if (!m.cron) continue;
    try {
      await m.cron(ctx);
    } catch (err) {
      ctx.log.error('cron failed', { module: m.name, err: String(err) });
    }
  }
}
