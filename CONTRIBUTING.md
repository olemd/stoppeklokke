# Contributing

Thanks for helping! A few ground rules first.

## Single-user by design

Stoppeklokke is deliberately single-user: one instance per person. Pull requests that add multiple users, teams, roles or approvals will be declined. Please open an issue before starting larger work.

## Setup

```sh
bun install
cp .dev.vars.example .dev.vars
bun run dev
```

Before opening a PR, all of these must pass:

```sh
bun run lint && bun run typecheck && bun run i18n:check && bun run test && bun run build
```

Use `bun run test`, **not** `bun test`. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (release-please builds the changelog from them). Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`.

Architecture and conventions are described in [CLAUDE.md](CLAUDE.md); behaviour is specified in [SPEC.md](SPEC.md).

## Add a translation

1. Copy `src/shared/i18n/en.json` to `src/shared/i18n/<locale>.json` (e.g. `de.json`, `pt-BR.json`).
2. Fill in `_meta`: `name` (in the language itself), `englishName`, and `dir` (`ltr` or `rtl`).
3. Translate the values. Keep `{placeholders}` unchanged. Plurals use suffixed keys (`hours_one`, `hours_other`, plus `_zero`, `_two`, `_few`, `_many` if your language needs them — see [CLDR plural rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html)).
4. Run `bun run i18n:check`. Missing keys are allowed (they fall back to English); stale keys and mismatched placeholders fail.

No code changes are needed: the language appears in the picker automatically.
