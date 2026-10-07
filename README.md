# Stoppeklokke

A small, fast, single-user time tracker (a lightweight Clockify) that runs for free on Cloudflare Workers + D1. Stopwatch and manual entries, workspaces for your different roles, optional hourly rates with inheritance, reports with CSV export, an invoice basis, period locking, and a PWA with push notifications when you've been at it for too long.

English and Norwegian Bokmål UI; adding a language is one JSON file.

## Single-user by design

One person per instance. If several people want Stoppeklokke, each deploys their own (it takes about 15 minutes and costs nothing). There is no `user_id` anywhere, and pull requests adding multiple users, teams or roles will be declined. This keeps the code small and your data in your own account.

## Deploy your own

_Full instructions are completed in a later milestone; see `scripts/bootstrap.ts`._

```sh
bun install
bunx wrangler login
bun run bootstrap
```

## Development

```sh
bun install
cp .dev.vars.example .dev.vars
bun run dev          # http://localhost:8787
bun run test         # never `bun test`
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md).

## Licence

[AGPL-3.0-or-later](LICENSE). If you run a modified version, point `SOURCE_URL` at your own repository so users can get the source (AGPL §13).
