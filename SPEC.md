# Stoppeklokke — single-user time tracking (lightweight Clockify)

> Specification for Claude Code. Read all of it before starting. Ask if anything is contradictory.
> Repo: `github.com/olemd/stoppeklokke` (open source, AGPL-3.0-or-later). Reference deployment: `https://stoppeklokke.silly.work`.
> Code, comments, commit messages, README and identifiers in English.
> UI is fully internationalised: English and Norwegian Bokmål from day one, structured so other translations can be added by dropping in one file (§7.5).

## 1. Goals and non-goals

**Goals**
- One user. Fast time tracking with a stopwatch and manual entry.
- **Workspaces** separate the user's different roles (self-employed, one or more employments, board work, …). Each has its own clients, projects, defaults and reports, while the timer and notifications stay global (§4.4).
- Time is tracked against a client, a project, both, or neither, always within a workspace.
- Sensible reporting with CSV export.
- Optional hourly rates with inheritance, plus rate locking and period locking for invoiced time.
- PWA (installable, works on mobile) with Web Push notifications for long sessions.
- Runs for free on Cloudflare (Workers + D1 + Static Assets + one Cron Trigger).
- CI/CD from GitHub to production.
- **Open source that others can fork and deploy to their own Cloudflare account in under 15 minutes**, without code changes.
- **Extensible:** new features are added as modules without touching the core (§15).

**Non-goals (v1)**
- Multiple users, teams, roles, approvals. **Deliberately single-user:** the multi-user story is one instance per person (fork + deploy, §11). Do not add `user_id` scoping.
- Tags.
- Task entities. Descriptions are free text with autocomplete from history.
- Import from Clockify or other tools.
- Invoice generation / PDF. Invoices are made in an external system; Stoppeklokke provides the **invoice basis** (§9.2) and period locks record that a period has been invoiced elsewhere.
- Full offline editing with sync. Offline means "read last known state"; the stopwatch can still be started/stopped offline via a queue (§7.3).

## 2. Platform and stack

| Part | Choice | Why |
|---|---|---|
| Runtime | Cloudflare Workers (free plan) | Free, nothing to operate |
| Database | Cloudflare D1 (SQLite) | Free, SQLite semantics, migrations via wrangler |
| Backend | TypeScript + Hono | Small, Workers-native, good routing/middleware |
| Frontend | Preact + Vite, built to static files served via Workers Static Assets | Small bundle, fast PWA |
| Auth | WebAuthn/passkeys (`@simplewebauthn/server` + `/browser`) | Phishing-resistant; cheap on CPU (the 10 ms limit rules out argon2/bcrypt) |
| Push | Web Push with VAPID, implemented with WebCrypto (no Node dependencies) | The `web-push` package needs Node crypto; WebCrypto is native in Workers |
| Validation | zod, shared between worker and web | One source of truth for API shapes and OpenAPI |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` | Tests run against the real Workers runtime and D1 |
| SQL | Raw SQL with prepared statements, no ORM | Small schema, full control, no magic |

### 2.1 Tooling: Bun first
- **Bun is the package manager and script runner.** `bun install`, lockfile `bun.lock` (text format) committed, no `package-lock.json`.
- **Own scripts** (`scripts/*`: bootstrap, reset-auth, vapid, seed, render-wrangler-config, i18n-check) are TypeScript run directly with `bun scripts/x.ts`. No `tsx`/`ts-node`. They may use Bun APIs (`Bun.file`, `Bun.$`).
- **Third-party tools (wrangler, vite, vitest, eslint, tsc) run on Node** via their own shebang: `bun run x` without `--bun` respects `#!/usr/bin/env node`. Wrangler and the Workers vitest pool are only officially supported on Node, and forcing them onto the Bun runtime is where the complications are. Node ≥ 20 is therefore still a prerequisite, but only as a runtime for those tools.
- **Never `bun test`.** That is Bun's own test runner and would bypass the Workers pool. The script is named `test` and invoked as `bun run test` (→ vitest). Add a guard: `bunfig.toml` with `[test] root = "./.no-bun-test"` so an accidental `bun test` finds nothing instead of running tests in the wrong runtime.
- **The Worker itself runs on workerd**, so Bun-specific APIs are banned in `src/` (eslint `no-restricted-globals`/`no-restricted-imports` for `Bun` and `bun:*`). Bun APIs only in `scripts/`.
- CI uses `oven-sh/setup-bun` (pinned version via `packageManager`/`.bun-version`) plus `actions/setup-node`.
- If a specific tool misbehaves under `bun install` (e.g. a postinstall script), fix it locally (`trustedDependencies` in `package.json`) rather than switching back to npm. If it cannot be fixed in under an hour, document it in `CLAUDE.md` and ask.

**Hard constraints from the free plan:** 10 ms CPU per request and per cron invocation, 100k requests/day, max 5 cron triggers per account. No CPU-heavy work on the request path. No heavy dependencies in the Worker bundle. Anything that scales with data size (export, import, period locks) must be either a single SQL statement or paginated/chunked across requests.

One Worker serves both the API (`/api/*`) and the static files. No separate Pages project.

## 3. Time and formats

- All timestamps are stored as **UTC epoch seconds (INTEGER)**.
- Display uses the time zone from the `timezone` setting, **never** the browser's time zone directly.
- **24-hour clock by default** (`clock_format = 24h`), independent of language. 12-hour is an override.
  Implementation: all formatting goes through one `formatTime/formatDate` module that passes `timeZone` and `hourCycle: 'h23'|'h12'` explicitly to `Intl.DateTimeFormat`. Otherwise e.g. `locale=en` would implicitly produce 12-hour times in some browsers. `<input type="time">` follows the browser's locale, so use a custom time input component (text field with `HH:MM` parsing and validation).
- Dates are `YYYY-MM-DD` in inputs and exports; a localised short format in the UI (`Wed 7 Oct` / `ons. 7. okt.`).
- Weeks start on Monday (ISO weeks).
- Durations are shown as `H:MM` (e.g. `7:45`). Decimal hours (`7.75` / `7,75` per locale) as an alternative in reports.

## 4. Data model (D1)

```sql
CREATE TABLE workspaces (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,   -- e.g. "Self-employed", "Odin Prosjekt"
  color                 TEXT NOT NULL DEFAULT '#888888',
  -- Overrides of global settings; NULL = inherit from settings (§4.3)
  currency              TEXT,
  default_hourly_rate   INTEGER,                -- minor units
  billable_default      INTEGER,
  rounding_min          INTEGER,
  rounding_mode         TEXT,
  daily_target_min      INTEGER,                -- target for this role alone
  alert_after_min       INTEGER,
  tick_interval_min     INTEGER,
  on_rate_change        TEXT,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  archived              INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE clients (
  id            INTEGER PRIMARY KEY,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  hourly_rate   INTEGER,              -- minor units (cents/øre); NULL = inherit from workspace
  currency      TEXT,                 -- NULL = inherit from workspace
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE projects (
  id                    INTEGER PRIMARY KEY,
  workspace_id          INTEGER NOT NULL REFERENCES workspaces(id),
  client_id             INTEGER REFERENCES clients(id),  -- NULL = internal / no client
  name                  TEXT NOT NULL,
  color                 TEXT NOT NULL DEFAULT '#4f7cff',
  hourly_rate           INTEGER,      -- minor units; NULL = inherit from client
  currency              TEXT,         -- NULL = inherit from client
  billable_default      INTEGER,      -- NULL = inherit from workspace
  alert_after_min       INTEGER,      -- NULL = inherit from workspace
  tick_interval_min     INTEGER,      -- NULL = inherit from workspace; 0 = off
  archived              INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (workspace_id, client_id, name)
);

CREATE TABLE period_locks (
  id            INTEGER PRIMARY KEY,
  from_date     TEXT NOT NULL,        -- YYYY-MM-DD as chosen by the user (display)
  to_date       TEXT NOT NULL,        -- inclusive
  from_at       INTEGER NOT NULL,     -- epoch bounds computed in the time zone at lock time;
  to_at         INTEGER NOT NULL,     -- stable even if the timezone setting changes later
  timezone      TEXT NOT NULL,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id),
  client_id     INTEGER REFERENCES clients(id),   -- NULL = all clients in the workspace
  project_id    INTEGER REFERENCES projects(id),  -- NULL = all projects (within the client)
  rounding_min  INTEGER NOT NULL,     -- frozen rounding so invoiced amounts never change
  rounding_mode TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',          -- e.g. invoice number
  locked_at     INTEGER NOT NULL
);

CREATE TABLE time_entries (
  id            INTEGER PRIMARY KEY,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id),
  client_id     INTEGER REFERENCES clients(id),
  project_id    INTEGER REFERENCES projects(id),
  description   TEXT NOT NULL DEFAULT '',
  start_at      INTEGER NOT NULL,
  end_at        INTEGER,              -- NULL = currently running
  billable      INTEGER NOT NULL DEFAULT 1,
  -- Rate lock: frozen result of resolveRate. rate_locked_at != NULL means locked
  -- (locked_rate may be NULL = "locked as having no rate").
  rate_locked_at   INTEGER,
  locked_rate      INTEGER,
  locked_currency  TEXT,
  period_lock_id   INTEGER REFERENCES period_locks(id),  -- != NULL = read-only
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (end_at IS NULL OR end_at > start_at),
  CHECK (period_lock_id IS NULL OR rate_locked_at IS NOT NULL)
);
-- At most one running timer:
CREATE UNIQUE INDEX one_running ON time_entries((1)) WHERE end_at IS NULL;
CREATE INDEX entries_start ON time_entries(start_at);
CREATE INDEX entries_workspace ON time_entries(workspace_id, start_at);
CREATE INDEX entries_project ON time_entries(project_id, start_at);
CREATE INDEX entries_period_lock ON time_entries(period_lock_id);
CREATE INDEX entries_description ON time_entries(description);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Auth
CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,     -- credential ID (base64url)
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL,
  transports    TEXT,
  label         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,     -- SHA-256 of the token; the raw token is never stored
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  user_agent    TEXT
);
CREATE TABLE recovery_codes (code_hash TEXT PRIMARY KEY, used_at INTEGER);
CREATE TABLE auth_challenges (challenge TEXT PRIMARY KEY, kind TEXT NOT NULL, expires_at INTEGER NOT NULL);

-- Push
CREATE TABLE push_subscriptions (
  endpoint      TEXT PRIMARY KEY,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  label         TEXT,
  created_at    INTEGER NOT NULL,
  last_ok_at    INTEGER
);
CREATE TABLE notification_log (
  entry_id      INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,        -- 'alert' | 'tick'
  seq           INTEGER NOT NULL,     -- tick number (1, 2, 3 ...); 0 for alert
  sent_at       INTEGER NOT NULL,
  PRIMARY KEY (entry_id, kind, seq)
);
```

**Rules**
- **Every entry that is not period-locked is fully editable** (start, end, description, client, project, billable), including the running timer (§6) and rate-locked entries. Locking is the only thing that restricts editing.
- If `project_id` is set and the project has a client, `client_id` is set to the project's client server-side. `workspace_id` is always derived from the project or client when either is set. A conflicting value is rejected with 400.
- A project with a client must be in the client's workspace (checked server-side).
- Both `client_id` and `project_id` may be NULL ("uncategorised"); the entry still belongs to a workspace (the active one when created). Reports show this as its own group per workspace.
- **Hourly rates are entirely optional** and inherit: **project → client → workspace → global (`settings.default_hourly_rate`) → no rate**. The first non-NULL value wins. Currency inherits the same way, independently of the rate.
  - An entry without a project uses client → workspace → global. An entry with neither uses workspace → global.
  - With a single workspace that has no overrides this is exactly the "project → client → general" model; the workspace level is invisible until used.
  - All lookup logic lives in one pure function `resolveRate(entry, project, client, workspace, settings) → {rate, currency, source: 'locked'|'project'|'client'|'workspace'|'default'|null}` in `core/`, with unit tests for every combination. It checks the rate lock (`rate_locked_at`) **first**.
  - **Non-billable entries (`billable = 0`) never produce an amount**, but count towards hour totals. Reports show billable and total hours separately.
  - No rate anywhere → no amount columns in the UI or reports (hidden, not shown as 0).
  - The UI shows the inherited value as a placeholder ("Inherited from client: 1,200 NOK/h") so it is clear where the rate comes from. Clearing the field means inherit, not 0. A rate of 0 is a valid, explicit value (pro bono).
- Money is always integers (minor units). Never floats. Amount rounding: per entry, half-up, to a whole minor unit.
- Reports sum **per currency**. Different currencies are never combined or converted.
- Archived clients/projects are hidden in pickers and shown in reports.

### 4.1 Locking

Two levels, because they solve different problems:

| | Rate lock | Period lock |
|---|---|---|
| Purpose | Preserve the old rate when a rate changes | Freeze a period once it has been invoiced in an external system |
| Freezes | rate + currency | rate + currency + rounding + the entry itself |
| Entry editable? | Yes (time, description, project) | No, fully read-only |
| Created by | a rate change (§4.2) or manually in the log | "Lock period" in reports |

**Period lock**
- The user picks a workspace (required, preselected to the active one), a period (from/to date), optionally a client and/or project, and a note (e.g. invoice number). A preview shows the number of entries, hours and amount per currency before confirming.
- Covers **completed** entries with `start_at` in `[from_at, to_at]` and matching scope. A running timer is never locked.
- In one D1 batch: create the `period_locks` row, set `rate_locked_at/locked_rate/locked_currency` on entries that don't already have a rate lock (an existing rate lock is kept, it is already frozen), and set `period_lock_id`. These are set-based `UPDATE … WHERE` statements, not per-row loops, to stay within the CPU limit.
- Entries in a period lock cannot be edited or deleted (409). New manual entries with `start_at` inside a locked period and scope are rejected (409); otherwise an invoiced period could change after the fact.
- An entry has at most one `period_lock_id`. A new lock skips already period-locked entries and says so in the preview.
- Reports for period-locked entries use the lock's `rounding_min/mode`, not the current setting.
- **Unlocking:** an explicit action with confirmation. Clears `period_lock_id` and deletes the lock. Dialog choice: "keep rate locks" (default) or "also release rates".

**Manual rate lock:** in the log, selected entries can be rate-locked or released (bulk). Releasing a rate lock is not allowed on period-locked entries.

**Moving a rate-locked entry to another client/project:** the frozen rate belongs to the old one. The UI asks: "Release rate lock and use the new project's rate" (default) or "Keep locked rate". API: a PATCH changing `project_id`/`client_id` on a rate-locked entry requires `rate_lock: 'release'|'keep'`, otherwise 409.

### 4.2 Rate change with locking of unlocked time

Applies when the rate **or** currency changes at project, client, workspace or global level.

1. The client calls `GET /api/rates/impact?level=project|client|workspace|default&id=…`, which returns affected entries: completed, not rate-locked, and where `resolveRate().source` is the level being changed. Response: count, hours, oldest/newest date, current rate.
2. If the count > 0, behaviour follows the `on_rate_change` setting:
   (`on_rate_change` itself inherits workspace → global.)
   - `ask` (**default**): dialog with
     - **Lock unlocked time at the old rate** (preselected)
     - **Lock only time before date …** (date picker, default today)
     - **Update history** (unlocked time gets the new rate)
   - `lock`: lock all affected without asking (toast with count and an undo button)
   - `update`: update without asking
3. A PATCH on project/client/workspace/settings that changes rate/currency accepts `rate_change: {mode: 'lock'|'lock_before'|'update', before?: epoch}`. The rate change and the locking happen in **one D1 batch** (atomic; otherwise a failure midway could leave the new rate without the lock).
4. Server-side guard: if `on_rate_change = ask`, affected entries > 0 and `rate_change` is missing → 409 with the impact data. Old clients and API scripts can then never silently rewrite history.
5. The running timer is never affected and gets the new rate.
6. Undo (in `lock` mode): the rate lock uses one shared `rate_locked_at` value; undo releases entries with exactly that value, within 5 minutes.

### 4.3 Settings

Key/value in `settings`, with defaults in code. Settings marked **W** can be overridden per workspace (and some further per project, see schema); the chain is always the most specific non-NULL value. All inheritance goes through one pure `resolveSetting(key, {project, client, workspace, settings})` in `core/`.

**Overrides:** `timezone`, `locale`, `currency` and `clock_format` are shown in the setup wizard, prefilled with the suggestions below, and can be changed there and later in settings. After setup the browser is **never** consulted again for these; the stored value wins. Validated server-side: `timezone` against `Intl.supportedValuesOf('timeZone')`, `currency` against ISO 4217 (`Intl.supportedValuesOf('currency')`), `locale` against the available translations.

| Key | Default | Meaning |
|---|---|---|
| `active_workspace_id` | first workspace | Workspace preselected in the UI (§4.4) |
| `timezone` | suggested from the browser at setup, fallback `UTC` | Display and day/week boundaries in reports |
| `locale` | suggested from the browser, matched to available translations (§7.5), fallback `en` | UI language and number/date format |
| `currency` **W** | suggested from the locale (`nb` → `NOK`, otherwise `EUR`) | Default currency when client/project has none |
| `clock_format` | `24h` | `24h` / `12h`. Never derived from the locale |
| `default_hourly_rate` **W** | `NULL` | General hourly rate (minor units); NULL = none |
| `on_rate_change` **W** | `ask` | `ask` / `lock` / `update` (§4.2) |
| `alert_after_min` **W** | `240` | "You've been at this for an unreasonably long time" after 4 h continuous |
| `tick_interval_min` **W** | `60` | "Tick tock" notification every hour; `0` = off |
| `quiet_hours` | `23:00-07:00` | No tick notifications in this window (alerts still go out) |
| `rounding_min` **W** | `0` | Rounding in reports: 0, 5, 6, 10, 15, 30 |
| `rounding_mode` **W** | `nearest` | `nearest` / `up` / `down` |
| `daily_target_min` | `450` | 7:30, total across all workspaces for "today's progress". Each workspace can also have its own target (shown per workspace) |
| `billable_default` **W** | `1` | Default billable flag for new entries (projects can override) |
| `idle_stop_after_min` | `0` | Auto-stop after X min; 0 = off (§8.3) |

### 4.4 Workspaces

A workspace is one role: self-employed, an employment, board work, a volunteer role, etc.

- **Owns:** clients, projects, entries (via `workspace_id`), period locks, and overrides of the **W** settings.
- **Global, not per workspace:** the single running timer (you can only do one thing at a time), notifications and quiet hours, time zone, language, clock format, auth, API tokens.
- Setup creates one workspace (name prompted in the wizard, default "Work"). **With only one workspace the switcher and all workspace columns are hidden**, so users who don't need this never see it.
- **Active workspace:** a switcher in the header sets `active_workspace_id`. It filters pickers, the log and reports, and is used for new uncategorised entries. "All workspaces" is a valid choice for the log and reports.
- The timer's client/project picker shows the active workspace first, then other workspaces in groups, so you can start a timer in another role without switching first. Starting a timer in another workspace does **not** change the active one.
- **Moving** a client to another workspace moves its projects and entries with it (one batch); blocked (409) if any of its entries are period-locked. Moving a single entry is just a PATCH of client/project (subject to the rate-lock rule in §4.1).
- **Archiving** a workspace hides it from the switcher and pickers; data stays in reports. No hard delete while it has entries.
- Typical setup for a consultant: "Self-employed" (NOK, own rates, billable default on, invoice basis used), "Employer AS" (billable default off, no rates, daily target 7:30 for flex/overtime tracking), "Board work" (rate per client).

## 5. Authentication and security

### 5.1 First-time setup
- Secret `SETUP_TOKEN` is set with `wrangler secret put`.
- `/setup?token=...` registers the first passkey **only while the `passkeys` table is empty**. After that `/setup` is disabled.
- Setup generates 10 recovery codes (shown once, stored as SHA-256 hashes) and runs the settings wizard (§4.3).

### 5.2 Login
- WebAuthn with `userVerification: 'required'`, `residentKey: 'required'` (discoverable, no username).
- RP ID = `RP_ID` from env; origin checked against `ORIGIN`.
- Challenges are stored in `auth_challenges` with a 5 min TTL and deleted on use (single-use).
- More passkeys can be added from settings (laptop, phone, YubiKey).
- A recovery code allows a single login and forces registration of a new passkey.

### 5.3 Sessions
- 32 random bytes → cookie `__Host-session`, `HttpOnly; Secure; SameSite=Strict; Path=/`.
- The DB stores only SHA-256(token).
- 30-day lifetime, sliding (renewed on use when < 15 days remain). The long lifetime is deliberate: a mobile PWA should not keep asking you to log in.
- "Log out all devices" deletes all sessions.

### 5.4 Operator recovery
`bun run reset-auth` (uses `wrangler d1 execute --remote`): deletes all passkeys, sessions and recovery codes after a typed confirmation, then tells the operator to set a new `SETUP_TOKEN` with `wrangler secret put` and visit `/setup`. Data is untouched. This does not weaken security: anyone with access to the Cloudflare account already owns the data.

### 5.5 General
- All `/api/*` except auth endpoints require a valid session or API token (§15.3).
- State-changing requests with a session cookie: `Origin` header must equal `ORIGIN` (in addition to SameSite), otherwise 403. Bearer-token requests are exempt (no ambient credentials).
- Rate limiting on auth endpoints: the Workers Rate Limiting binding if available on the free plan, otherwise a simple counter in D1 (10 attempts / 10 min per IP).
- Security headers on every response: strict CSP (`default-src 'self'`, no inline script), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, minimal `Permissions-Policy`, HSTS.
- All input validated with zod at the API boundary. Prepared statements only.
- No secrets in the repo. Everything via `wrangler secret` / GitHub Secrets.

## 6. API (JSON, REST-ish)

```
POST   /api/auth/register/options | /verify   (setup and "add passkey")
POST   /api/auth/login/options    | /verify
POST   /api/auth/recovery
POST   /api/auth/logout
POST   /api/auth/logout-all
GET    /api/auth/passkeys            DELETE /api/auth/passkeys/:id

GET    /api/workspaces               POST /api/workspaces
PATCH  /api/workspaces/:id           (incl. overrides, archive)
POST   /api/clients/:id/move         {workspace_id}  (§4.4)

GET    /api/clients?workspace_id     POST /api/clients
PATCH  /api/clients/:id              (archive via PATCH; no hard delete when entries exist)
GET    /api/projects?workspace_id    POST /api/projects
PATCH  /api/projects/:id

GET    /api/timer                    -> running entry or null
POST   /api/timer/start              {client_id?, project_id?, description?, start_at?}
                                     Stops any running timer atomically first (batch).
POST   /api/timer/stop               {end_at?, force?, cut_at_lock?}
PATCH  /api/timer                    {client_id?, project_id?, description?, start_at?, billable?}
                                     Edit the running entry without stopping it (e.g. forgot to start → move start_at back)
POST   /api/timer/discard            Delete the running entry

GET    /api/entries?from&to&workspace_id&client_id&project_id&q&locked
POST   /api/entries                  manual entry
PATCH  /api/entries/:id
DELETE /api/entries/:id
POST   /api/entries/:id/continue     Start a new timer with the same client/project/description
POST   /api/entries/rate-lock        {ids[]} | {from,to,client_id?,project_id?}
POST   /api/entries/rate-unlock      {ids[]} | {locked_at} (undo)

GET    /api/rates/impact?level&id    affected unlocked entries for a rate change (§4.2)

GET    /api/locks                    POST /api/locks/preview   POST /api/locks
DELETE /api/locks/:id?release_rates=0|1

GET    /api/reports/summary?from&to&workspace_id&group_by=workspace|client|project|day|week|month&billable=&locked=
GET    /api/reports/detailed?from&to&...
GET    /api/reports/export.csv?from&to&...

GET    /api/suggestions/descriptions?q&project_id   (autocomplete, §7.1)
GET    /api/settings                 PATCH /api/settings

GET    /api/export?collection&cursor  (§9.1)
POST   /api/import                    (§9.1)

GET    /api/push/vapid-public-key
POST   /api/push/subscribe           DELETE /api/push/subscribe
POST   /api/push/test

GET    /api/health                   {status, version, git_sha, config_errors[]}
GET    /api/openapi.json
```

**Entry validation**
- `end_at > start_at`. Max duration 24 h per entry (overridable with `force: true`; the UI asks "are you sure").
- Overlapping entries are allowed but flagged in the UI and in reports. Not blocked, since it is often intentional.
- Start/end may not be more than 5 min in the future.

**Timer edge cases**
- A timer running past midnight is never split or stopped automatically (apart from `idle_stop_after_min`). Reports split it across days (§9).
- Starting a timer with a `start_at` inside a locked period is rejected (409).
- Stopping a timer whose `start_at` is inside a period that was locked while it was running → 409 with the lock bounds. The UI offers "cut at the lock boundary" (`cut_at_lock: true`): the part inside the lock is discarded, and the entry restarts at `to_at`. This is rare (you would have to lock the current period while timing), but it must not corrupt a lock.
- Stopping a timer that has run > 24 h → the UI shows the duration and asks for a corrected end time, or `force` to keep it. Server returns 409 without `force`.

## 7. Frontend / PWA

### 7.1 Screens
1. **Timer (home):** Big start/stop button; the running entry's project, description and start time are editable in place while it runs, client/project picker (searchable, recently used first), description field with autocomplete. Running time ticks locally (computed from `start_at`, not polled). Below: today's entries grouped, with the daily total and progress towards `daily_target_min` (total, plus per-workspace bars when more than one workspace has a target). "Continue" button per entry.
   **Autocomplete:** suggestions ranked by recency and frequency over the last 90 days, scoped to the selected project first, then global. Picking a suggestion also selects the client/project last used with that description if none is selected. Debounced 150 ms; max 10 results; case-insensitive prefix match first, then substring.
2. **Log:** Week view, entries per day, inline editing of time/description/project. Manual entry ("+ add") with start/end or start/duration. Padlock icon on period-locked entries (read-only) and a separate icon for rate locks (tooltip with the frozen rate). Multi-select for rate lock/release.
3. **Reports:** Workspace filter (active / specific / all); with "all" the default grouping is by workspace. Period picker (this week, last week, this month, last month, this year, custom); defaults to this week. Group by client/project/day/week/month. Shows hours, billable hours, amount per currency. Filter "locked / unlocked / all" (unlocked = "not invoiced yet"). "Lock period" button using the current period and filters as the starting point. List of period locks with notes and unlock. Simple per-day bar chart (inline SVG, no chart library). CSV export.
4. **Workspaces, clients and projects:** CRUD for all three (workspaces section only shown with more than one, plus an "Add workspace" button), moving clients between workspaces, colours, rates (with inherited placeholder), notification overrides, archiving.
5. **Settings:** All settings from §4.3 (time zone/language/currency/clock format at the top), passkeys, push subscriptions per device (+ test button), API tokens, webhooks, data export/import, log out everywhere.
6. **Footer (every page, including login):** "Stoppeklokke vX.Y.Z · Source code (AGPL-3.0)" linking to `SOURCE_URL`. Version and git SHA are baked in at build time.

### 7.2 PWA
- `manifest.webmanifest` with name, icons (192/512 + maskable), `display: standalone`, `start_url: /`. Manifest name/description localised per build default (`en`).
- Service worker: precache the app shell (hand-written or a minimal Vite plugin; avoid Workbox bloat). Network-first for `/api/*`, cache fallback for GET.
- Push handler in the SW: shows the notification with actions **"Stop"** and **"Keep going"**. "Stop" calls `/api/timer/stop` directly from the SW (cookie is sent; same-origin POST includes `Origin`) and shows a confirmation.
- iOS: Web Push requires the app to be added to the home screen, and the installed PWA has its own cookie jar (log in once inside it). Show an explanation in settings when `Notification` is unavailable.

### 7.3 Offline stopwatch
- Start/stop while offline is queued in IndexedDB with client timestamps and replayed when back online. The server accepts client-supplied `start_at`/`end_at` within the validation rules. Replays that hit 409 (e.g. locked period) are surfaced to the user, never dropped silently.
- Everything else requires a connection in v1.

### 7.4 Keyboard shortcuts (desktop)
`s` start/stop, `n` new manual entry, `/` focus project picker, `Esc` close.

### 7.5 Internationalisation
- Translations live in `src/shared/i18n/<locale>.json` (shared by web **and** worker, because push notification text and CSV headers are generated server-side).
- `en.json` is the source of truth. `nb.json` ships in v1.
- **Adding a language = adding one JSON file.** Locales are discovered at build time (Vite `import.meta.glob` for web, a generated index for the worker); no code changes needed. Each file has a `_meta` block: `{ "name": "Norsk bokmål", "englishName": "Norwegian Bokmål", "dir": "ltr" }`.
- Message format: `{name}` interpolation and plurals via `Intl.PluralRules` with suffixed keys (`hours_one`, `hours_other`, plus whatever categories the language needs). No ICU MessageFormat library (bundle size).
- Fallback chain at runtime: exact locale (`nb-NO`) → language (`nb`) → `en`. Missing keys fall back to `en` and log a warning in dev.
- Locale suggestion at setup: match `navigator.languages` against available locales in order; `no` and `nn` map to `nb` when no `nn` translation exists; otherwise `en`.
- CI script `bun run i18n:check`: fails on keys in a translation that don't exist in `en` (stale), warns on missing keys (incomplete translations are allowed), and validates placeholders match.
- `dir` from `_meta` is applied to `<html>` so RTL languages can be added later without layout rewrites (use logical CSS properties: `margin-inline-start` etc.).
- `CONTRIBUTING.md` has a short "Add a translation" section.

## 8. Notifications (cron)

### 8.1 Cron
- One trigger: `*/5 * * * *`.
- The handler does at most: one SELECT (running entry + project overrides + settings), decides what to send, sends push, writes `notification_log`. Must stay well under 10 ms CPU; I/O wait doesn't count.
- Notification text is rendered in the user's `locale` (§7.5) and uses `clock_format`/`timezone`.

### 8.2 Logic
For the running entry with duration `d` minutes:
- **Alert:** `d >= alert_after_min` (project → global) and no `('alert', 0)` in the log → send "You've been on {project} for an unreasonably long time: {H:MM}. Take a break?".
- **Tick:** `n = floor(d / tick_interval_min)`; if `n >= 1`, interval ≠ 0, not in quiet hours, and `('tick', n)` not in the log → send "Tick tock — {n} h on {project}".
- The `notification_log` primary key makes sending idempotent even if cron runs twice. Write the log row **before** sending (`INSERT OR IGNORE`; send only if a row was inserted).
- Push response 404/410 → delete the subscription. Other errors → log, no retry.

### 8.3 Auto-stop (optional, off by default)
If `idle_stop_after_min > 0` and the duration exceeds it: stop the entry at `start_at + idle_stop_after_min` and notify that it was stopped. Off by default, because silently losing time is worse than one extra notification.

### 8.4 Web Push implementation
- VAPID keys (P-256) are generated once by a script (`bun run vapid`) and stored as secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto:).
- Encryption: RFC 8291 (`aes128gcm`) with WebCrypto: ECDH, HKDF, AES-GCM. VAPID JWT ES256 signed with WebCrypto. Own module `src/modules/push/` with unit tests against the RFC 8291 test vectors.

## 9. Reporting details

- Day/week boundaries are computed in `timezone`, not UTC. An entry crossing midnight is split proportionally in day grouping.
- Rounding is applied **per entry** before summing, only in report views and exports. Raw data is never modified. Period-locked entries use the lock's rounding.
- CSV: UTF-8 with BOM (Excel-friendly). Separator and decimal mark follow the locale by default (`nb`: `;` and `,`; `en`: `,` and `.`), overridable with `?sep=,&decimal=.`. Columns: date, start, end, duration (H:MM), workspace, hours (decimal), client, project, description, billable, rate, currency, amount, locked, lock note. Headers localised; `?headers=keys` gives stable English machine keys for scripts.

### 9.1 Full data export/import (backup and moving between instances)
- **Export:** `GET /api/export?collection=…&cursor=…` returns one collection page at a time (≤ 500 rows). The browser pages through `settings, workspaces, clients, projects, period_locks, time_entries` and assembles one JSON file: `{format: "stoppeklokke", version: 1, exported_at, app_version, data: {…}}`. Paginated so no single request exceeds the CPU limit regardless of data size.
- Excluded from export: passkeys, sessions, recovery codes, push subscriptions, API token hashes, webhook secrets.
- **Import:** only into an instance with no clients/projects/entries (after setup), to avoid merge semantics. The browser validates the file (zod, `version`), then sends it in chunks (≤ 500 rows per `POST /api/import`), in dependency order, keeping original IDs. A final call verifies row counts. A failed import can be retried after an explicit "wipe imported data" action.
- Format version is bumped on breaking schema changes; the importer supports all earlier versions (migration functions in `core/export/`).

### 9.2 Invoice basis
A report preset made to be the source for an invoice written elsewhere:
- Pick workspace and client (required) and period; defaults to last month and **unlocked entries only** (= not yet invoiced).
- Grouped client → project → description, with summed hours (after rounding), rate, currency and amount per line, project subtotals and grand total per currency. Non-billable time listed separately as "not invoiced", so it is visible but does not pollute the total.
- Optional "detailed" toggle listing every entry with date and times, for clients who require an itemised appendix.
- Export: CSV (same rules as above) and a clean print view (print CSS, no app chrome) for saving as PDF from the browser. No server-side PDF.
- A "Lock this period" button directly in the view, prefilled with client, period and an empty note for the invoice number. Typical workflow: review basis → create invoice externally → lock with invoice number.

## 10. Repo structure

```
/
├─ src/
│  ├─ core/            # Domain logic. Plain TS, no Cloudflare imports. Testable in isolation.
│  │  ├─ time/         # time zones, rounding, splitting across midnight
│  │  ├─ entries/      # timer rules, validation
│  │  ├─ rates/        # resolveRate, locking rules
│  │  ├─ reports/
│  │  ├─ export/       # export format, version migrations
│  │  └─ ports.ts      # interfaces: Db, Clock, PushSender, Scheduler, Logger
│  ├─ modules/         # Feature modules (§15): auth, clients, projects, timer, entries,
│  │                   # reports, locks, push, settings, export, webhooks, tokens
│  ├─ shared/
│  │  ├─ i18n/         # en.json, nb.json, ...
│  │  └─ schemas/      # zod schemas shared by worker and web
│  ├─ platform/
│  │  └─ cloudflare/   # Worker entry, D1 adapter, cron, env parsing. The only place with CF APIs.
│  └─ web/             # Preact app, SW, manifest, icons
├─ migrations/         # 0001_init.sql, ... (wrangler d1 migrations)
├─ scripts/            # bootstrap, reset-auth, vapid-keygen, seed-dev, render-wrangler-config, i18n-check
├─ test/
├─ wrangler.template.jsonc
├─ .github/
│  ├─ workflows/       # ci, deploy, backup, codeql
│  ├─ dependabot.yml
│  └─ ISSUE_TEMPLATE/
├─ LICENSE
├─ README.md           # what it is, screenshots, deploy from scratch on your own CF account;
│                      # states up front that it is single-user by design (one instance per person)
├─ CONTRIBUTING.md     # incl. "Add a translation"
├─ SECURITY.md         # how to report vulnerabilities (GitHub private advisories)
├─ CHANGELOG.md        # generated by release-please
└─ CLAUDE.md           # conventions for further work
```

## 11. CI/CD (GitHub Actions)

**`ci.yml`, on PR and push:**
1. `bun install --frozen-lockfile`
2. `bun run lint` (eslint + prettier --check, SPDX header check)
3. `bun run typecheck` (tsc --noEmit, strict)
4. `bun run i18n:check`
5. `bun run test` (vitest in the Workers pool, local D1 with migrations)
6. `bun run build` (frontend + worker)
7. Licence check of dependencies (§15.6)

**`deploy.yml`, on push to `main` after green CI:**
1. Build.
2. `wrangler d1 migrations apply DB --remote`
3. `wrangler deploy`
4. Smoke test: `GET /api/health` → 200 with the expected git SHA and no `config_errors`.

**GitHub Secrets:** `CLOUDFLARE_API_TOKEN` (scoped: Workers Scripts:Edit, D1:Edit, Account Settings:Read, Zone/Workers Routes:Edit for the custom domain), `CLOUDFLARE_ACCOUNT_ID`.
**GitHub Variables (not secret):** `ORIGIN`, `RP_ID`, `D1_DATABASE_ID`, `WORKER_NAME` (default `stoppeklokke`), `CUSTOM_DOMAIN` (optional), `SOURCE_URL` (optional).

**Fork friendliness:**
- `wrangler.jsonc` is **not** committed. CI renders it from `wrangler.template.jsonc` + Variables (`scripts/render-wrangler-config`). Locally it is rendered from `.dev.vars`/`.env`. No account-specific IDs or domains live in the repo.
- `deploy.yml` skips (with a clear message, not a failure) when `CLOUDFLARE_API_TOKEN` is missing. Forks without setup get green CI without attempting a deploy.
- `scripts/bootstrap` (interactive, run once locally): creates the D1 database, applies migrations, generates VAPID keys and `SETUP_TOKEN`, sets wrangler secrets, and prints which GitHub Variables/Secrets to set (or sets them via `gh` if installed).
- Investigate whether the "Deploy to Cloudflare" button works with D1 + secrets for this setup. If so, add it to the README. If not, document the bootstrap path.
- README notes that a Workers custom domain requires the zone to be on Cloudflare; otherwise use `*.workers.dev`.
- README has a short "Single-user by design" section near the top: one person per instance, deploy your own; multi-user PRs will be declined. Mirrored in `CONTRIBUTING.md` and as a note in the feature-request issue template, so it is seen before effort is spent.

**Migration rule:** additive migrations only (expand/contract). Never DROP/RENAME in the same release as the code that stops using the column, because migrations run before deploy.

**Backup:** weekly workflow (`schedule`) runs `wrangler d1 export --remote` and uploads it as an Actions artifact (90-day retention). Free, and keeps a copy outside Cloudflare. D1 Time Travel exists in addition. Note in README: for a public repo, artifacts are only downloadable by users with repo access, but forks should still be private or disable this workflow if they consider their time data sensitive.

**Maintenance (free for public repos):** Dependabot for bun (`bun.lock`) and Actions, CodeQL, release-please for versioning and CHANGELOG (Conventional Commits).

**Branch protection on `main`:** requires green CI.

## 12. Configuration

Vars: `ORIGIN` (e.g. `https://stoppeklokke.silly.work`), `RP_ID` (e.g. `stoppeklokke.silly.work`), `RP_NAME` (default `Stoppeklokke`), `SOURCE_URL` (default `https://github.com/olemd/stoppeklokke`; forks with modifications **must** point this to their own repo, per AGPL §13). Secrets: `SETUP_TOKEN`, `VAPID_*`.
Env is validated with zod at startup. Missing/invalid values → a clear message in `/api/health` `config_errors`, not a cryptic 500.
No domain, name, time zone or currency is hard-coded anywhere. Every setting in §4.3 has a default in code and can be overridden in the UI.

**README warning:** `RP_ID` binds passkeys to the domain. Changing domains means registering passkeys again (use `bun run reset-auth` + `/setup`).

Local development: `bun run dev` (wrangler dev with local D1 + Vite). `bun run seed` loads demo data. Passkeys work on `localhost` without HTTPS.

## 13. Acceptance criteria

- [ ] Fresh deploy → `/setup` → register passkey → settings wizard → log in on laptop and phone (two passkeys).
- [ ] Start a timer on the phone, see it ticking on the laptop after refresh. Stop it from the laptop.
- [ ] Starting a new timer while one is running stops the old one automatically, no overlap.
- [ ] Push "tick tock" after 1 h and alert after 4 h, each sent exactly once. "Stop" in the notification stops the timer.
- [ ] Last month's report grouped by client, with amounts and 15-min rounding; CSV opens correctly in Excel/LibreOffice with both `en` and `nb` locales.
- [ ] Entry crossing midnight is split correctly in the day report.
- [ ] Rate inheritance: general 1000, client 1200, project 1500 → project entry 1500, client entry without project 1200, uncategorised 1000. Remove the project rate → 1200. No rates anywhere → no amounts shown. Non-billable entry → hours counted, no amount.
- [ ] Clients in EUR and NOK in the same report → two separate totals.
- [ ] Single workspace → no switcher, no workspace column anywhere.
- [ ] Two workspaces ("Self-employed" with default rate 1000 NOK, "Employer" with no rate and billable off) → entries in each get the right defaults; reports filter per workspace and "all" groups by workspace; the timer can be started in "Employer" while "Self-employed" is active without switching.
- [ ] Rate chain with workspace: global 900, workspace 1000, client 1200, project 1500 → 1500/1200/1000; remove the workspace rate → uncategorised entries in it fall back to 900.
- [ ] Move a client with entries to another workspace → its projects and entries follow; blocked if any entry is period-locked.
- [ ] Running timer: change project and move start 30 min back without stopping → duration and notifications adjust (tick/alert computed from the new start).
- [ ] Invoice basis for a client last month → lines per project/description, matches the summary report total; after locking with an invoice number, the same view with "unlocked only" is empty.
- [ ] Change a client rate from 1200 to 1400 with "lock unlocked" → old entries show 1200, new 1400. With "update history" → all 1400. A project with its own rate under that client is unaffected in both cases.
- [ ] PATCH of a rate without `rate_change` when `on_rate_change=ask` and affected entries exist → 409.
- [ ] Period lock for September → entries cannot be edited/deleted, a new manual entry in September is rejected, amounts unchanged after changing rate and rounding. Unlocking makes them editable again.
- [ ] Changing `timezone` after a period lock does not change which entries are locked.
- [ ] With `locale=en` and `clock_format=24h` all times show as `14:30`, never `2:30 PM`. Time zone set to `America/New_York` in settings on a browser in Oslo → all times in New York time.
- [ ] Adding `de.json` with a subset of keys → German appears in the language picker, missing keys fall back to English, no code changes.
- [ ] Export from one instance, import into a fresh instance → identical reports, including locks.
- [ ] `bun run reset-auth` → old passkeys rejected, `/setup` works with the new token, all data intact.
- [ ] All API calls without a session → 401. Cross-origin POST → 403.
- [ ] No request or cron run over 10 ms CPU in Workers Logs under normal use, including export/import of 10,000 entries.
- [ ] Lighthouse: installable PWA; the app shell loads offline.
- [ ] Footer link to the source with the correct version on every page, including login.
- [ ] Push to main → CI → migration → deploy → smoke test, with no manual steps.
- [ ] New fork on a clean CF account: `bootstrap` + set Variables/Secrets → working deploy, no code changes.
- [ ] `grep -r silly.work src/` returns nothing.
- [ ] No imports of Cloudflare types outside `src/platform/cloudflare/` (enforced with eslint `no-restricted-imports`).

## 14. Milestones (in order)

1. Skeleton: repo, module structure (§15), wrangler template + bootstrap, D1, migration 0001, Hono, health endpoint, i18n setup (`en` + `nb`), CI + deploy pipeline. **Deploy early** to `stoppeklokke.silly.work`.
2. Auth (setup, passkeys, sessions, recovery codes, `reset-auth`).
3. Workspaces/clients/projects/entries CRUD + `resolveSetting`/`resolveRate` + timer endpoints + tests. Build workspaces in from the start; retrofitting a top-level scope later touches every query.
4. Frontend: timer screen (with autocomplete) and log.
5. Reports + CSV + invoice basis (§9.2), then rate locks, the rate-change flow and period locks (§4.1–4.2).
6. PWA (manifest, SW, offline queue).
7. Web Push + cron + notification logic.
8. API tokens + webhooks + OpenAPI.
9. Data export/import.
10. Polish: shortcuts, backup workflow, README, CONTRIBUTING, SECURITY, Deploy button.

## 15. Extensibility

The goal is that new features (tags, task entities, invoicing, integrations) can be added without changing the core.

### 15.1 Modules
Each feature is a folder `src/modules/<name>/` exporting:

```ts
export interface Module {
  name: string;
  routes?: (app: Hono<AppEnv>) => void;           // mounted under /api/<name>
  settings?: SettingDef[];                         // key, zod schema, default; shown automatically in settings
  migrations?: string;                             // path to this module's SQL migrations, if any
  onEvent?: (e: DomainEvent, ctx: Ctx) => Promise<void>;
  cron?: (ctx: Ctx) => Promise<void>;              // run from the single shared cron trigger
  exportCollections?: ExportCollection[];          // included in §9.1 export/import
}
```
Modules are registered in one list (`src/modules/index.ts`). No dynamic loading; explicit is easier to debug.

### 15.2 Domain events
The core emits events through a simple in-process event bus: `timer.started`, `timer.stopped`, `entry.created|updated|deleted`, `lock.created|deleted`, `rate.changed`, `alert.sent`. Push notifications and webhooks are just listeners, so new integrations never touch timer code.

### 15.3 Integration points shipped in v1
- **Personal API tokens** (`tokens` module): `Authorization: Bearer sk_...`, stored hashed, optional scope (`read` / `write`), expiry date. Enables use from CLI, scripts, Home Assistant, Stream Deck, an MCP server, etc.
- **Outgoing webhooks** (`webhooks` module): URL + events + HMAC-SHA256 signature header. Run with `ctx.waitUntil`, no retry queue in v1 (failures are logged).
- **OpenAPI spec** generated from the zod schemas (`@hono/zod-openapi`), served at `/api/openapi.json`. Gives third-party clients something stable to build against.

### 15.4 Portability (designed for, not shipped in v1)
All database access goes through the `Db` port in `core/ports.ts`, and no code outside `platform/cloudflare/` imports Cloudflare types. That makes a later `platform/bun/` (Bun + built-in `bun:sqlite`, cron via `setInterval`, no native modules) a bounded piece of work for people who want to self-host without Cloudflare. v1 ships and tests only the Cloudflare platform.

### 15.5 Schema changes
- Additive migrations only (§11).
- New modules get their own tables prefixed with the module name (`webhooks_*`, `tokens_*`).
- The `settings` table is key/value precisely to avoid migrations for new settings.
- Export format changes bump `version` with a migration function (§9.1).

### 15.6 Licence
**AGPL-3.0-or-later** (see LICENSE).
- SPDX header in every source file: `// SPDX-License-Identifier: AGPL-3.0-or-later`. Checked in CI.
- AGPL §13 requires network users to have access to the source of the running version. The footer link (§7.1) to `SOURCE_URL` satisfies this. The README explains that forks with modifications must point `SOURCE_URL` at their own repo.
- Dependencies must have AGPL-compatible licences (MIT, BSD, Apache-2.0, ISC, etc.). CI runs a licence check (e.g. `license-checker --onlyAllow`) and fails on unknown or incompatible licences.
- `package.json`: `"license": "AGPL-3.0-or-later"`.
