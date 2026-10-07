-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Personal API tokens (§15.3). Only SHA-256 of the token is stored.
CREATE TABLE tokens_tokens (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,          -- first characters, to recognise a token in the list
  scope         TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  expires_at    INTEGER,                -- NULL = never
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
