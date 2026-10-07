// SPDX-License-Identifier: AGPL-3.0-or-later
/** Test platform: D1 inside the Workers runtime (vitest-pool-workers). */
import { env } from 'cloudflare:test';
import { d1Db } from '../../src/platform/cloudflare/d1';

export const PLATFORM = 'cloudflare';
export const db = d1Db(env.DB);
export const testEnv = env as unknown as Record<string, unknown>;
