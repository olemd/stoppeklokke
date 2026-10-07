-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Auth additions (§5). Additive only.

-- A session created by a recovery code may only register a new passkey (§5.2).
ALTER TABLE sessions ADD COLUMN must_register INTEGER NOT NULL DEFAULT 0;

-- Rate limiting for auth endpoints: 10 attempts / 10 min per IP (§5.5). The
-- Workers Rate Limiting binding only supports 10 s / 60 s windows, so a D1
-- counter is used instead (also keeps the app portable).
CREATE TABLE auth_attempts (
  ip  TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX auth_attempts_ip_at ON auth_attempts(ip, at);
