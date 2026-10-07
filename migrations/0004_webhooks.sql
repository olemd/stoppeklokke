-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Outgoing webhooks (§15.3): URL + events + HMAC-SHA256 secret.
-- The secret must be stored in plain text to sign requests; it is excluded
-- from data exports (§9.1).
CREATE TABLE webhooks_hooks (
  id            INTEGER PRIMARY KEY,
  url           TEXT NOT NULL,
  events        TEXT NOT NULL,          -- JSON array of event types
  secret        TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_at       INTEGER,
  last_status   INTEGER,                -- HTTP status of the last delivery, 0 = network error
  last_error    TEXT
);
