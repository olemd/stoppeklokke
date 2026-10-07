// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * API shapes shared by the Worker and the web app (§2): one source of truth
 * for validation, OpenAPI and the client's types.
 */
import { z } from 'zod';

export const Id = z.coerce.number().int().positive();
export const Epoch = z.number().int().min(0).max(4_102_444_800); // up to 2100
export const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');
export const Currency = z.string().regex(/^[A-Z]{3}$/, 'expected an ISO 4217 code');
/** Hourly rate in minor units. null = inherit. 0 is a valid explicit rate (pro bono). */
export const Rate = z.number().int().min(0).max(100_000_000).nullable();
export const Minutes = z.number().int().min(0).max(100_000);
export const Name = z.string().trim().min(1).max(200);
export const Description = z.string().max(2000);
export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const RoundingMin = z.union([
  z.literal(0),
  z.literal(5),
  z.literal(6),
  z.literal(10),
  z.literal(15),
  z.literal(30),
]);
export const RoundingMode = z.enum(['nearest', 'up', 'down']);
export const OnRateChange = z.enum(['ask', 'lock', 'update']);

/** Rate change instruction (§4.2) accepted by PATCHes that change a rate or currency. */
export const RateChange = z.object({
  mode: z.enum(['lock', 'lock_before', 'update']),
  before: Epoch.optional(),
});

// ── Workspaces ─────────────────────────────────────────────────────────────

export const WorkspaceOverrides = z.object({
  currency: Currency.nullable(),
  default_hourly_rate: Rate,
  billable_default: z.boolean().nullable(),
  rounding_min: RoundingMin.nullable(),
  rounding_mode: RoundingMode.nullable(),
  daily_target_min: Minutes.nullable(),
  alert_after_min: Minutes.nullable(),
  tick_interval_min: Minutes.nullable(),
  on_rate_change: OnRateChange.nullable(),
});

export const Workspace = WorkspaceOverrides.extend({
  id: z.number(),
  name: z.string(),
  color: z.string(),
  sort_order: z.number(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Workspace = z.infer<typeof Workspace>;

export const WorkspaceCreate = WorkspaceOverrides.partial().extend({
  name: Name,
  color: Color.optional(),
  sort_order: z.number().int().optional(),
});
export const WorkspacePatch = WorkspaceCreate.partial().extend({
  archived: z.boolean().optional(),
  rate_change: RateChange.optional(),
});

// ── Clients ────────────────────────────────────────────────────────────────

export const Client = z.object({
  id: z.number(),
  workspace_id: z.number(),
  name: z.string(),
  hourly_rate: z.number().nullable(),
  currency: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Client = z.infer<typeof Client>;

export const ClientCreate = z.object({
  workspace_id: Id.optional(),
  name: Name,
  hourly_rate: Rate.optional(),
  currency: Currency.nullable().optional(),
});
export const ClientPatch = z.object({
  name: Name.optional(),
  hourly_rate: Rate.optional(),
  currency: Currency.nullable().optional(),
  archived: z.boolean().optional(),
  rate_change: RateChange.optional(),
});

// ── Projects ───────────────────────────────────────────────────────────────

export const Project = z.object({
  id: z.number(),
  workspace_id: z.number(),
  client_id: z.number().nullable(),
  name: z.string(),
  color: z.string(),
  hourly_rate: z.number().nullable(),
  currency: z.string().nullable(),
  billable_default: z.boolean().nullable(),
  alert_after_min: z.number().nullable(),
  tick_interval_min: z.number().nullable(),
  archived: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Project = z.infer<typeof Project>;

export const ProjectCreate = z.object({
  workspace_id: Id.optional(),
  client_id: Id.nullable().optional(),
  name: Name,
  color: Color.optional(),
  hourly_rate: Rate.optional(),
  currency: Currency.nullable().optional(),
  billable_default: z.boolean().nullable().optional(),
  alert_after_min: Minutes.nullable().optional(),
  tick_interval_min: Minutes.nullable().optional(),
});
export const ProjectPatch = ProjectCreate.omit({ workspace_id: true }).partial().extend({
  archived: z.boolean().optional(),
  rate_change: RateChange.optional(),
});

// ── Time entries ───────────────────────────────────────────────────────────

export const Entry = z.object({
  id: z.number(),
  workspace_id: z.number(),
  client_id: z.number().nullable(),
  project_id: z.number().nullable(),
  description: z.string(),
  start_at: z.number(),
  end_at: z.number().nullable(),
  billable: z.boolean(),
  rate_locked_at: z.number().nullable(),
  locked_rate: z.number().nullable(),
  locked_currency: z.string().nullable(),
  period_lock_id: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  /** Resolved rate (after rate lock / inheritance). null = no rate anywhere. */
  rate: z.number().nullable(),
  currency: z.string(),
  rate_source: z.enum(['locked', 'project', 'client', 'workspace', 'default']).nullable(),
  /** Overlaps another entry in the same result set (§6: flagged, not blocked). */
  overlaps: z.boolean().optional(),
});
export type Entry = z.infer<typeof Entry>;

const EntryRefs = {
  workspace_id: Id.nullable().optional(),
  client_id: Id.nullable().optional(),
  project_id: Id.nullable().optional(),
};

export const EntryCreate = z.object({
  ...EntryRefs,
  description: Description.default(''),
  start_at: Epoch,
  end_at: Epoch,
  billable: z.boolean().optional(),
  force: z.boolean().optional(),
});
export const EntryPatch = z.object({
  ...EntryRefs,
  description: Description.optional(),
  start_at: Epoch.optional(),
  end_at: Epoch.optional(),
  billable: z.boolean().optional(),
  force: z.boolean().optional(),
  /** Required when moving a rate-locked entry to another client/project (§4.1). */
  rate_lock: z.enum(['release', 'keep']).optional(),
});

export const TimerStart = z.object({
  ...EntryRefs,
  description: Description.optional(),
  start_at: Epoch.optional(),
  billable: z.boolean().optional(),
  force: z.boolean().optional(),
});
export const TimerStop = z.object({
  end_at: Epoch.optional(),
  force: z.boolean().optional(),
  cut_at_lock: z.boolean().optional(),
});
/** Strict: an `end_at` here would silently not stop the timer, so unknown keys are rejected. */
export const TimerPatch = z.strictObject({
  ...EntryRefs,
  description: Description.optional(),
  start_at: Epoch.optional(),
  billable: z.boolean().optional(),
  rate_lock: z.enum(['release', 'keep']).optional(),
});

// ── Settings ───────────────────────────────────────────────────────────────

export const SettingsPatch = z
  .object({
    active_workspace_id: Id.nullable(),
    timezone: z.string(),
    locale: z.string(),
    currency: Currency,
    clock_format: z.enum(['24h', '12h']),
    default_hourly_rate: Rate,
    on_rate_change: OnRateChange,
    alert_after_min: Minutes,
    tick_interval_min: Minutes,
    quiet_hours: z.string(),
    rounding_min: RoundingMin,
    rounding_mode: RoundingMode,
    daily_target_min: Minutes,
    billable_default: z.boolean(),
    idle_stop_after_min: Minutes,
    setup_complete: z.boolean(),
  })
  .partial()
  .extend({ rate_change: RateChange.optional() });

export const ErrorBody = z.object({ error: z.string(), message: z.string() }).loose();
