// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The full data export format (§9.1):
 *   { format: "stoppeklokke", version, exported_at, app_version, data: {…} }
 *
 * `version` is bumped on breaking schema changes. The importer upgrades any
 * earlier version step by step through MIGRATIONS, so old backups always
 * import. Collections are listed in dependency (import) order.
 */
import { z } from 'zod';

export const FORMAT = 'stoppeklokke';
export const CURRENT_VERSION = 1;
export const MAX_PAGE = 500;

export const COLLECTIONS = [
  'settings',
  'workspaces',
  'clients',
  'projects',
  'period_locks',
  'time_entries',
] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

export const ExportDoc = z.object({
  format: z.literal(FORMAT),
  version: z.number().int().min(1),
  exported_at: z.number(),
  app_version: z.string(),
  data: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
export type ExportDoc = z.infer<typeof ExportDoc>;

/** version N → N+1. Add an entry here whenever CURRENT_VERSION is bumped. */
const MIGRATIONS: Record<number, (doc: ExportDoc) => ExportDoc> = {};

export function upgrade(doc: ExportDoc): ExportDoc {
  if (doc.version > CURRENT_VERSION) {
    throw new Error(
      `Export version ${doc.version} is newer than this app supports (${CURRENT_VERSION}).`,
    );
  }
  let d = doc;
  while (d.version < CURRENT_VERSION) {
    const step = MIGRATIONS[d.version];
    if (!step) throw new Error(`No migration from export version ${d.version}`);
    d = { ...step(d), version: d.version + 1 };
  }
  return d;
}
