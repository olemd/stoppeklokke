# CLAUDE.md — conventions for Stoppeklokke

Read `SPEC.md` first; it is the source of truth for behaviour. This file records how the code is organised and the rules that keep it that way.

## Commands (Bun is the package manager and script runner)

- `bun install` — never npm/yarn/pnpm. Lockfile `bun.lock` is committed.
- `bun run test` — vitest inside the Workers runtime. **Never `bun test`** (Bun's own runner bypasses the Workers pool; `bunfig.toml` points it at an empty dir).
- `bun run test:bun` — the same integration suite against the self-hosted platform (SQLite via bun:sqlite), vitest running on Bun; plus Bun-only tests in `test/bun/`. Both suites must pass.
- `bun run lint` — Biome (lint + format check, warnings fail) + SPDX header check. `bun run format` applies Biome's formatting and safe fixes.
- `bun run typecheck` — tsc for every tsconfig (app, cf, bun, web, sw, scripts).
- `bun run i18n:check`, `bun run build`, `bun run licenses`.
- `bun run dev` (local D1 on :8787), `bun run seed [-- --force]` (deterministic demo data), `bun run screenshots` (regenerates docs/screenshots; needs the dev server and Playwright's Chromium: `node node_modules/playwright/cli.js install chromium`), `bun scripts/icons.ts` (PWA icons from SVG).
- Before committing: lint, typecheck, i18n:check, test, test:bun, build must all pass.

## Commits and releases

- Every commit message is a [Conventional Commit](https://www.conventionalcommits.org/): `type(scope): summary`, e.g. `feat(reports): …`, `fix(bun): …`, `docs: …`. No `Area: summary` style.
- release-please (`.github/workflows/release-please.yml`) runs on push to `main` only and reads these types: `feat` → minor, `fix` → patch, `feat!`/`BREAKING CHANGE:` → major. `docs`, `chore`, `build`, `ci`, `test`, `refactor` give no release. A user-visible change must be `feat` or `fix`, or it never ships in a release or the CHANGELOG.
- Feature branches reach `main` through a PR; a push to a feature branch never releases. PRs are merged with a merge commit, so each commit message on the branch lands on `main` as written: get it right before pushing.
- If a non-conventional commit has already reached `main`, never rewrite `main`. Put `BEGIN_COMMIT_OVERRIDE` / the corrected message(s) / `END_COMMIT_OVERRIDE` in the body of the merged PR that brought it in, and release-please uses that instead. The override replaces the message of **every** commit in that PR (merge commit included), so it only works on a PR that landed as a single commit; on a multi-commit PR it repeats the line once per commit in the CHANGELOG. Otherwise fix it with the next PR: one commit carrying the correct `feat`/`fix` message lands it in the next release. Never write the start marker anywhere else in a PR body, not even in a code span: release-please treats any occurrence as an override and parses the text after it as the commit message.
- Check the release PR's CHANGELOG before merging it. Fixing it means fixing its source (commit messages or overrides), since release-please regenerates its branch on every push to `main`.

## Layout and boundaries

- `src/core/` — pure domain logic. No Hono, no Cloudflare. Unit-testable.
- `src/modules/<name>/` — features (§15). Each exports a `Module` and is listed in `src/modules/index.ts`. Routes mount at `/api/<name>` unless `mountPath` is set.
- `src/platform/bun/` — the self-hosted platform (docs/self-hosting.md): SQLite `Db` adapter, migration runner, static files from the same `_headers`, `Bun.serve`, cron. Bun APIs are allowed here; Cloudflare APIs are not. `bun run build:server` → `dist/server/server.js`; `Containerfile` + `deploy/` for Podman/Caddy.
- `src/platform/cloudflare/` — the **only** place allowed to use Cloudflare APIs/types (Biome `noRestrictedImports`/`noRestrictedGlobals` overrides in `biome.json`; `tsconfig.app.json` has no workers types, so stray usage fails typecheck).
- `src/shared/` — zod schemas and i18n JSON shared by Worker and web.
- `src/web/` — Preact PWA; `src/web/sw/` is the service worker (separate tsconfig).
- `scripts/` — operator scripts, run with `bun scripts/x.ts`. Bun APIs allowed **only** here and in `src/platform/bun/`.

## Rules

- SPDX header `// SPDX-License-Identifier: AGPL-3.0-or-later` in every source file (JSON exempt).
- Raw SQL with prepared statements via the `Db` port (`src/core/ports.ts`). Never string-interpolate values into SQL.
- Money is integer minor units. Timestamps are UTC epoch seconds. Display always goes through `src/core/time/format.ts` with explicit `timeZone` and `hourCycle`.
- 10 ms CPU budget per request/cron run: anything scaling with data size must be one set-based SQL statement or paginated.
- Multi-statement writes that must be atomic use `db.batch()`.
- Migrations are additive only (expand/contract) — they run before deploy.
- New module tables are prefixed with the module name (`tokens_*`, `webhooks_*`).
- New settings go in the key/value `settings` table, never a migration.
- All UI strings and server-rendered text (push, CSV headers) go through i18n. `en.json` is the source of truth.
- Single-user by design: never add `user_id` scoping.
- Errors: throw `HttpError` (src/core/errors.ts); the app maps it to `{error, message, ...details}`.

## Modules (src/modules)

health, auth (passkeys, sessions, recovery, rate limit), settings, workspaces, clients, projects, timer, entries (+ bulk rate locks), rates (§4.2 rate-change flow), suggestions, reports (+ CSV, invoice basis), locks (period locks), push (Web Push + cron), tokens, webhooks, export/import. Domain rules shared by timer and entries live in `entries/service.ts`.

## Gotchas

- The vitest pool's workerd is older than wrangler's; keep `compatibility_date` ≤ what the pool supports (currently `2026-08-15`, set in both `wrangler.template.jsonc` and `vitest.config.ts`).
- Linting/formatting use Biome instead of ESLint + Prettier (SPEC §11 names ESLint): typescript-eslint needs TypeScript's JS API, which TS 7 (the Go port) does not have. Biome has its own parser, so `tsc` (TS 7) is used for type checking only. Off on purpose in biome.json: `noNonNullAssertion` (we use `!` with `noUncheckedIndexedAccess`), `noImportantStyles` (reduced-motion/print CSS), `noDescendingSpecificity`. `biome-ignore` comments carry a reason; the ARIA combobox options are the main case.
- `src/shared/i18n/catalogs.generated.ts` is generated by `bun run gen` (run automatically by test/build/typecheck/lint) and not committed.
- `wrangler.jsonc` is rendered from `wrangler.template.jsonc` and never committed.
- `@cloudflare/workers-types` spells the ECDH param `$public`; the runtime (and the standard) uses `public`. See the cast in `modules/push/webpush.ts`.
- `/assets/*` runs through the Worker so a missing hashed file is a 404, not the SPA's index.html cached as immutable.
- The service worker caches only an allow-list of GET endpoints (`OFFLINE_API` in `src/web/sw/sw.ts`); add an endpoint there only if it is needed offline and holds no secrets.
- Account-level routes (tokens, webhooks, passkeys, import) use `requireSession`: API tokens must never reach them.
- Platform-specific behaviour goes through `Ctx` (e.g. `ctx.clientIp(req)`), never by reading platform headers in modules. Tests get their database from the `@test/platform` alias (`test/platform/{cloudflare,bun}.ts`); keep shared tests platform-neutral and put platform-only tests in `test/cloudflare/` or `test/bun/`.
- Self-hosted client IPs: `X-Forwarded-For` is only believed from `TRUSTED_PROXIES` (right-most untrusted hop). Never trust it unconditionally — that bypasses the auth rate limit.
- Under Bun, vitest needs `deps.interopDefault: false` (zod's re-exported namespace).
- Test CSV bytes with `arrayBuffer()`: `Response.text()` strips a UTF-8 BOM on workerd but not on Bun.
- After `bun run format`, edit with exact strings from the reformatted file (Biome reflows lines).
