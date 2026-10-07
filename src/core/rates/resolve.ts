// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Hourly rate inheritance (§4): project → client → workspace → global → none.
 * Currency inherits along the same chain, independently of the rate.
 * A rate lock (rate_locked_at != NULL) wins over everything, including a
 * locked "no rate" (locked_rate = NULL).
 */
import type { ClientRow, EntryRow, ProjectRow, WorkspaceRow } from '../model';
import type { Settings } from '../settings/defs';

export type RateSource = 'locked' | 'project' | 'client' | 'workspace' | 'default';

export interface ResolvedRate {
  rate: number | null;
  currency: string;
  source: RateSource | null;
}

type RateFields = { hourly_rate: number | null; currency: string | null };

export function resolveRate(
  entry: Pick<EntryRow, 'rate_locked_at' | 'locked_rate' | 'locked_currency'> | null,
  project: RateFields | null | undefined,
  client: RateFields | null | undefined,
  workspace: Pick<WorkspaceRow, 'default_hourly_rate' | 'currency'> | null | undefined,
  settings: Pick<Settings, 'default_hourly_rate' | 'currency'>,
): ResolvedRate {
  const currency =
    project?.currency ?? client?.currency ?? workspace?.currency ?? settings.currency;

  if (entry && entry.rate_locked_at !== null) {
    return {
      rate: entry.locked_rate,
      currency: entry.locked_currency ?? currency,
      source: 'locked',
    };
  }
  const chain: [RateSource, number | null | undefined][] = [
    ['project', project?.hourly_rate],
    ['client', client?.hourly_rate],
    ['workspace', workspace?.default_hourly_rate],
    ['default', settings.default_hourly_rate],
  ];
  for (const [source, rate] of chain) {
    if (rate !== null && rate !== undefined) return { rate, currency, source };
  }
  return { rate: null, currency, source: null };
}

/** The pieces resolveRate needs, looked up for one entry from preloaded maps. */
export interface RateLookup {
  projects: Map<number, ProjectRow>;
  clients: Map<number, ClientRow>;
  workspaces: Map<number, WorkspaceRow>;
  settings: Settings;
}

export function resolveEntryRate(
  entry: Pick<
    EntryRow,
    | 'project_id'
    | 'client_id'
    | 'workspace_id'
    | 'rate_locked_at'
    | 'locked_rate'
    | 'locked_currency'
  >,
  l: RateLookup,
): ResolvedRate {
  const project = entry.project_id !== null ? l.projects.get(entry.project_id) : null;
  const clientId = project?.client_id ?? entry.client_id;
  const client = clientId !== null && clientId !== undefined ? l.clients.get(clientId) : null;
  return resolveRate(entry, project, client, l.workspaces.get(entry.workspace_id), l.settings);
}
