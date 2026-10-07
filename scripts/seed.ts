// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Loads demo data into the LOCAL D1 database (`bun run seed`, §12): three
 * workspaces, clients in two currencies, projects and six weeks of realistic
 * entries in Europe/Oslo. Deterministic (seeded PRNG), so screenshots in the
 * docs are reproducible.
 *
 * Refuses to run if time entries already exist, unless --force (which wipes
 * workspaces/clients/projects/entries/locks first; passkeys are kept).
 * Usage: bun run seed [--force] [--today=YYYY-MM-DD]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, dateOf, parseDate, weekdayOf, zonedToEpoch } from '../src/core/time/tz';
import { wrangler } from './lib';

const TZ = 'Europe/Oslo';
const force = process.argv.includes('--force');
const todayArg = process.argv.find((a) => a.startsWith('--today='))?.slice(8);
const today = todayArg ?? dateOf(Math.floor(Date.now() / 1000), TZ);

// mulberry32: tiny deterministic PRNG.
let seed = 0x5eed;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
const q = (v: string | number | null) =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`;

const now = Math.floor(Date.now() / 1000);
const sql: string[] = [];
const insert = (table: string, row: Record<string, string | number | null>) =>
  sql.push(
    `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(q).join(', ')});`,
  );

if (force) {
  sql.push(
    'DELETE FROM notification_log;',
    'DELETE FROM time_entries;',
    'DELETE FROM period_locks;',
    'DELETE FROM projects;',
    'DELETE FROM clients;',
    'DELETE FROM workspaces;',
  );
}

const settings: Record<string, unknown> = {
  timezone: TZ,
  locale: 'en',
  currency: 'NOK',
  clock_format: '24h',
  default_hourly_rate: null,
  setup_complete: true,
  active_workspace_id: 1,
  rounding_min: 15,
  rounding_mode: 'nearest',
};
for (const [k, v] of Object.entries(settings)) {
  sql.push(
    `INSERT INTO settings (key, value) VALUES (${q(k)}, ${q(JSON.stringify(v))}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
  );
}

const ws = [
  {
    id: 1,
    name: 'Self-employed',
    color: '#0b6e4f',
    currency: 'NOK',
    default_hourly_rate: 100000,
    billable_default: 1,
    daily_target_min: null,
  },
  {
    id: 2,
    name: 'Nordlys AS',
    color: '#1d4ed8',
    currency: null,
    default_hourly_rate: null,
    billable_default: 0,
    daily_target_min: 300,
  },
  {
    id: 3,
    name: 'Board work',
    color: '#8a4b00',
    currency: null,
    default_hourly_rate: null,
    billable_default: 1,
    daily_target_min: null,
  },
];
ws.forEach((w, i) =>
  insert('workspaces', { ...w, sort_order: i, created_at: now, updated_at: now }),
);

const clients = [
  { id: 1, workspace_id: 1, name: 'Acme AS', hourly_rate: 120000, currency: null },
  { id: 2, workspace_id: 1, name: 'Fjord Media', hourly_rate: 110000, currency: null },
  { id: 3, workspace_id: 1, name: 'Euro GmbH', hourly_rate: 11000, currency: 'EUR' },
  { id: 4, workspace_id: 3, name: 'Housing co-op', hourly_rate: 80000, currency: null },
];
clients.forEach((c) => insert('clients', { ...c, created_at: now, updated_at: now }));

const projects = [
  { id: 1, workspace_id: 1, client_id: 1, name: 'Website', color: '#4f7cff', hourly_rate: null },
  {
    id: 2,
    workspace_id: 1,
    client_id: 1,
    name: 'Mobile app',
    color: '#c2410c',
    hourly_rate: 150000,
  },
  {
    id: 3,
    workspace_id: 1,
    client_id: 2,
    name: 'Brand refresh',
    color: '#a21caf',
    hourly_rate: null,
  },
  {
    id: 4,
    workspace_id: 1,
    client_id: 3,
    name: 'API integration',
    color: '#0e7490',
    hourly_rate: null,
  },
  { id: 5, workspace_id: 1, client_id: null, name: 'Admin', color: '#6b7280', hourly_rate: null },
  {
    id: 6,
    workspace_id: 2,
    client_id: null,
    name: 'Platform team',
    color: '#1d4ed8',
    hourly_rate: null,
  },
  {
    id: 7,
    workspace_id: 3,
    client_id: 4,
    name: 'Board meetings',
    color: '#8a4b00',
    hourly_rate: null,
  },
];
projects.forEach((p) =>
  insert('projects', { ...p, currency: null, created_at: now, updated_at: now }),
);

const work: Record<number, string[]> = {
  1: ['Landing page copy', 'Fix navigation on mobile', 'Content migration', 'Review with client'],
  2: ['Push notifications', 'Release 2.3', 'Crash triage', 'Sprint planning'],
  3: ['Logo sketches', 'Colour palette', 'Workshop', 'Guidelines document'],
  4: ['OAuth flow', 'Webhook handling', 'Error mapping', 'Call with Berlin team'],
  5: ['Invoicing', 'Email', 'Bookkeeping'],
  6: ['Stand-up', 'Code review', 'Incident follow-up', 'Architecture review', 'Pairing'],
  7: ['Board meeting', 'Budget review'],
};

let id = 1;
const entry = (
  projectId: number,
  day: string,
  h: number,
  m: number,
  minutes: number,
  billable?: number,
) => {
  const p = projects.find((x) => x.id === projectId)!;
  const w = ws.find((x) => x.id === p.workspace_id)!;
  const { year, month, day: d } = parseDate(day);
  const start = zonedToEpoch(year, month, d, h, m, TZ);
  insert('time_entries', {
    id: id++,
    workspace_id: p.workspace_id,
    client_id: p.client_id,
    project_id: p.id,
    description: pick(work[p.id]!),
    start_at: start,
    end_at: start + minutes * 60,
    billable: billable ?? w.billable_default,
    created_at: start,
    updated_at: start,
  });
};

// Six weeks of weekdays, ending yesterday.
for (let i = 42; i >= 1; i--) {
  const day = addDays(today, -i);
  if (weekdayOf(day) > 5) continue;
  // Employer mornings: 5 hours of platform work in two blocks.
  entry(6, day, 8, pick([0, 15]), pick([120, 150, 165]));
  entry(6, day, 11, pick([0, 15, 30]), pick([90, 105, 120]));
  // Self-employed afternoons: two or three client blocks.
  let h = 14;
  for (let n = 0; n < pick([2, 2, 3]); n++) {
    const minutes = pick([45, 60, 75, 90, 105, 120]);
    entry(pick([1, 1, 2, 3, 4, 5]), day, h, pick([0, 5, 10]), minutes, undefined);
    h += Math.ceil(minutes / 60) + 0;
  }
  if (weekdayOf(day) === 3 && i % 14 < 7) entry(7, day, 18, 0, 120);
}

const dir = mkdtempSync(join(tmpdir(), 'stoppeklokke-seed-'));
try {
  const file = join(dir, 'seed.sql');
  writeFileSync(file, sql.join('\n') + '\n');
  if (!force) {
    const out = await wrangler([
      'd1',
      'execute',
      'DB',
      '--local',
      '--json',
      '--command',
      'SELECT COUNT(*) AS n FROM time_entries',
    ]);
    const n = (JSON.parse(out) as { results: { n: number }[] }[])[0]?.results[0]?.n ?? 0;
    if (n > 0) {
      console.error(
        `The local database already has ${n} entries. Use --force to replace demo data.`,
      );
      process.exit(1);
    }
  }
  await wrangler(['d1', 'execute', 'DB', '--local', '--file', file]);
  console.log(`Seeded ${id - 1} entries ending ${addDays(today, -1)} (${TZ}).`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
