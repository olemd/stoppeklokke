-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Initial schema (SPEC §4). Additive migrations only from here on (§11).

CREATE TABLE workspaces (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
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
-- SQLite treats NULLs as distinct in UNIQUE constraints, so the constraint above
-- does not stop two internal (client-less) projects with the same name in one
-- workspace. This expression index closes that gap.
CREATE UNIQUE INDEX projects_unique_internal_name ON projects(workspace_id, name) WHERE client_id IS NULL;

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
