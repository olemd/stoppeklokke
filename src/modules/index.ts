// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The module registry (§15.1). Explicit list, no dynamic loading: easier to
 * debug. Order matters only for export collections, which carry their own order.
 */
import { authModule } from './auth';
import { healthModule } from './health';
import type { Module } from './types';

export const modules: Module[] = [healthModule, authModule];
