-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Clients can override the billable default (§4.3): project → client →
-- workspace → settings. NULL = inherit from the workspace.
ALTER TABLE clients ADD COLUMN billable_default INTEGER;
