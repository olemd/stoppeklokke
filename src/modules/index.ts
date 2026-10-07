// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The module registry (§15.1). Explicit list, no dynamic loading: easier to
 * debug. Order matters only for export collections, which carry their own order.
 */
import { authModule } from './auth';
import { clientsModule } from './clients';
import { entriesModule } from './entries';
import { healthModule } from './health';
import { locksModule } from './locks';
import { projectsModule } from './projects';
import { ratesModule } from './rates';
import { reportsModule } from './reports';
import { settingsModule } from './settings';
import { suggestionsModule } from './suggestions';
import { timerModule } from './timer';
import type { Module } from './types';
import { workspacesModule } from './workspaces';

export const modules: Module[] = [
  healthModule,
  authModule,
  settingsModule,
  workspacesModule,
  clientsModule,
  projectsModule,
  timerModule,
  entriesModule,
  ratesModule,
  suggestionsModule,
  reportsModule,
  locksModule,
];
