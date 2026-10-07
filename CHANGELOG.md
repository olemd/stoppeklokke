# Changelog

## [0.2.0](https://github.com/olemd/stoppeklokke/compare/stoppeklokke-v0.1.0...stoppeklokke-v0.2.0) (2026-10-07)


### Features

* API tokens, webhooks and OpenAPI (milestone 8) ([f7164ed](https://github.com/olemd/stoppeklokke/commit/f7164edd5e497bfabaa9a43f7793475e0c021589))
* **auth:** passkeys, sessions, recovery codes and reset-auth (milestone 2) ([5e90d18](https://github.com/olemd/stoppeklokke/commit/5e90d184958868f198d84cbb7585fb1b5d84d443))
* full data export and import (milestone 9) ([8f6be3d](https://github.com/olemd/stoppeklokke/commit/8f6be3d244ae115f235538d6b0613c5b92e8182b))
* project skeleton (milestone 1) ([d4ec603](https://github.com/olemd/stoppeklokke/commit/d4ec603c4b008186fddac989c02085c6cbb6b4d6))
* **push:** Web Push, cron notifications and auto-stop (milestone 7) ([51fc4d5](https://github.com/olemd/stoppeklokke/commit/51fc4d5f29adc66d80181f753e65a5dae993b7f2))
* **pwa:** manifest, service worker and offline stopwatch (milestone 6) ([444aa53](https://github.com/olemd/stoppeklokke/commit/444aa531f292c6fbc4acfee9ead4efc88a3077ab))
* reports, CSV, invoice basis and period locks (milestone 5) ([3cf40fa](https://github.com/olemd/stoppeklokke/commit/3cf40fa3a35046378532e9fc5e17434bf23077b6))
* **web:** keyboard shortcuts n, / and Esc (§7.4) ([54a418f](https://github.com/olemd/stoppeklokke/commit/54a418f094ac4236b5d16aaa5e335b1db8b2cb57))
* **web:** timer, log, projects and settings screens (milestone 4) ([2631569](https://github.com/olemd/stoppeklokke/commit/263156996afbd30743aace8be9bec64ace4c5cbe))
* workspaces, clients, projects, entries and timer API (milestone 3) ([d9115f1](https://github.com/olemd/stoppeklokke/commit/d9115f1700bbb32dd2813fc9634b1ed1fa07d103))


### Bug Fixes

* **auth:** rate limit setup token attempts on /register/options ([7278506](https://github.com/olemd/stoppeklokke/commit/72785061e5e9a0e5293b64a3b961f4df09b95d18))
* **ci:** encrypt the weekly D1 backup artifact ([dad853f](https://github.com/olemd/stoppeklokke/commit/dad853f21f35c022aa9d0cc9f8a8fa1be254d6f2))
* issues found by Biome's stricter rule set ([d8526b0](https://github.com/olemd/stoppeklokke/commit/d8526b0ce7d11ae199d8252a6ad81580566cc587))
* **pwa:** keep personal data out of the offline caches after logout ([c7aea90](https://github.com/olemd/stoppeklokke/commit/c7aea90c7bbf50c364e707607e4fb2d94ac52b33))
* return 404 for missing hashed assets instead of the SPA page ([de38e30](https://github.com/olemd/stoppeklokke/commit/de38e302d1fe7c2319bf33a3275a0c49319dcc72))
