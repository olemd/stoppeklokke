# Self-hosting Stoppeklokke (without Cloudflare)

Stoppeklokke runs on Cloudflare Workers by default ([README](../README.md#deploy-your-own)). It can also run on your own server: one [Bun](https://bun.sh) process serves the API and the app, stores data in a single SQLite file, and runs the notification schedule itself. The application code is the same; only the platform layer differs (`src/platform/bun/` instead of `src/platform/cloudflare/`), and the full test suite runs against both.

- [Which one should I choose?](#which-one-should-i-choose)
- [What you need](#what-you-need)
- [Option A: container with Podman (recommended)](#option-a-container-with-podman-recommended)
- [Option B: Bun directly with systemd](#option-b-bun-directly-with-systemd)
- [Reverse proxy and client addresses](#reverse-proxy-and-client-addresses)
- [Configuration reference](#configuration-reference)
- [First-time setup](#first-time-setup)
- [Operations](#operations)
- [Moving from Cloudflare](#moving-from-cloudflare)

## Which one should I choose?

| | Cloudflare | Self-hosted |
|---|---|---|
| Cost | Free plan | Your server |
| You operate | Nothing | Server, TLS, backups, updates |
| Data lives in | Your Cloudflare account (D1) | One SQLite file on your disk |
| Limits | 10 ms CPU per request, 100k requests/day | None that matter for one person |
| Deploys | Push to `main` | Pull a new image (or rebuild) |

Both can live side by side in one fork; nothing in the code has to change.

## What you need

- A Linux server, a domain name pointing at it, and ports 80/443 open.
- **HTTPS.** This is not optional: passkeys only work in a secure context, and the `__Host-` session cookie requires `Secure`. The examples use [Caddy](https://caddyserver.com), which gets and renews certificates automatically.
- Either Podman (option A), or Bun (the version pinned in `package.json`) plus Node.js ≥ 20 for building (option B).

## Option A: container with Podman (recommended)

The image is published to `ghcr.io/olemd/stoppeklokke` with every release (`:<version>` and `:latest`). It runs as a non-root user, with a read-only root filesystem, and keeps the database on the `/data` volume. If you maintain a fork, the image is published under your own account; make the package public once in GitHub → Packages → Package settings, or log in to GHCR on the server.

**1. Configuration.** Create the environment file and keep it private:

```sh
mkdir -p ~/.config/stoppeklokke
curl -fsSL https://raw.githubusercontent.com/olemd/stoppeklokke/main/deploy/stoppeklokke.env.example \
  -o ~/.config/stoppeklokke/stoppeklokke.env
chmod 600 ~/.config/stoppeklokke/stoppeklokke.env
```

Fill in at least `ORIGIN`, `RP_ID` and `SETUP_TOKEN` (`openssl rand -base64 24`). For push notifications, generate VAPID keys with the image itself and paste them into the file:

```sh
podman run --rm --entrypoint bun ghcr.io/olemd/stoppeklokke:latest -e "const k=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']);const b=(x)=>Buffer.from(x).toString('base64url');console.log('VAPID_PUBLIC_KEY='+b(await crypto.subtle.exportKey('raw',k.publicKey)));console.log('VAPID_PRIVATE_KEY='+(await crypto.subtle.exportKey('jwk',k.privateKey)).d)"
```

Set `VAPID_SUBJECT` to a `mailto:` address push services can contact. Keep the keys: changing them invalidates every device's push subscription.

**2. Service.** Install the [Quadlet unit](../deploy/stoppeklokke.container) for rootless Podman and start it:

```sh
mkdir -p ~/.config/containers/systemd
curl -fsSL https://raw.githubusercontent.com/olemd/stoppeklokke/main/deploy/stoppeklokke.container \
  -o ~/.config/containers/systemd/stoppeklokke.container
systemctl --user daemon-reload
systemctl --user start stoppeklokke
loginctl enable-linger "$USER"   # keep it running after you log out
```

The unit publishes the port on `127.0.0.1:8787` only, so nothing but the reverse proxy on the same host can reach it. Check it with `curl -s http://127.0.0.1:8787/api/health`.

**3. Reverse proxy.** Use the [Caddyfile](../deploy/Caddyfile) (replace the domain) and reload Caddy. Then set `TRUSTED_PROXIES` as described in [Reverse proxy and client addresses](#reverse-proxy-and-client-addresses).

**4. Updates.** The unit has `AutoUpdate=registry`: enable `podman-auto-update.timer` (`systemctl --user enable --now podman-auto-update.timer`) to pull new `:latest` images daily, or run `podman auto-update` yourself. Pin a version instead of `:latest` if you prefer to upgrade deliberately.

To build the image yourself instead (the build metadata ends up in the image labels and `/etc/build-info`):

```sh
BUILDAH_FORMAT=docker podman build \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg GIT_REVISION="$(git describe --always --dirty --abbrev=40)" \
  --build-arg APP_VERSION="$(jq -r .version package.json)" \
  -t localhost/stoppeklokke .
scripts/container-smoke.sh localhost/stoppeklokke   # optional: the same smoke test CI runs
```

## Option B: Bun directly with systemd

```sh
git clone https://github.com/olemd/stoppeklokke && cd stoppeklokke
bun install --frozen-lockfile
bun run build:web && bun run build:server   # → dist/web and dist/server/server.js
cp deploy/stoppeklokke.env.example .env && chmod 600 .env   # then edit it
bun run start
```

`bun run start` reads `.env` from the working directory, applies database migrations and listens on `127.0.0.1:8787`. The defaults put the database in `./data/stoppeklokke.sqlite`. A systemd unit (`/etc/systemd/system/stoppeklokke.service`, running as a dedicated `stoppeklokke` user):

```ini
[Unit]
Description=Stoppeklokke time tracker
After=network-online.target
Wants=network-online.target

[Service]
User=stoppeklokke
WorkingDirectory=/opt/stoppeklokke
ExecStart=/usr/local/bin/bun dist/server/server.js
Restart=always
TimeoutStopSec=30
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/stoppeklokke/data
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

To update: `git pull`, rebuild both bundles, `systemctl restart stoppeklokke`.

## Reverse proxy and client addresses

The login rate limit (10 attempts per 10 minutes per address) needs each visitor's real address. Behind a proxy the server only sees the proxy, so the proxy passes the client address in `X-Forwarded-For` — and the server must know which proxy to believe:

- `TRUSTED_PROXIES` lists the proxy's address(es) **as the server sees them**: IPs or CIDR ranges, comma-separated, IPv4 or IPv6.
- `X-Forwarded-For` is only read when a request comes from one of those addresses. Anyone else, for example someone reaching the port directly, cannot choose their own address and dodge the limit.
- If the server logs `X-Forwarded-For from an untrusted address` with a `proxy_address`, add that address. Until you do, all visitors share the proxy's address, and a burst of failed logins from anyone would lock you out for 10 minutes.

For Caddy on the same host as option B, the default `127.0.0.1,::1` is right. With rootless Podman the address the container sees depends on the network mode, so check the log once after the first request through Caddy. Keeping the published port on `127.0.0.1` (as the Quadlet unit does) is what makes trusting that address safe.

## Configuration reference

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `ORIGIN` | yes | | Public address, e.g. `https://stoppeklokke.example.com` (no trailing slash) |
| `RP_ID` | yes | | Passkey domain: the host of `ORIGIN`. Passkeys are bound to it |
| `SETUP_TOKEN` | for setup | | One-time token for `/setup?token=…`, ≥ 16 characters |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | for push | | Web Push keys; all three or none |
| `TRUSTED_PROXIES` | behind a proxy | (none) | See [above](#reverse-proxy-and-client-addresses) |
| `SOURCE_URL` | | upstream repo | Source link in the footer. Must point at your fork if you modify the code (AGPL §13) |
| `PORT` | | `8787` | Listening port |
| `HOST` | | `127.0.0.1` (image: `0.0.0.0`) | Listening address |
| `DATABASE_PATH` | | `./data/stoppeklokke.sqlite` (image: `/data/stoppeklokke.sqlite`) | SQLite file; created if missing |
| `STATIC_DIR` | | `./dist/web` (image: `/app/web`) | Built PWA |
| `MIGRATIONS_DIR` | | `./migrations` (image: `/app/migrations`) | SQL migrations, applied at startup |

`GET /api/health` reports `config_errors` if something is missing or inconsistent (for example an `RP_ID` that does not match `ORIGIN`).

## First-time setup

Open `https://<your-domain>/setup?token=<SETUP_TOKEN>`, register a passkey and save the recovery codes. The [user guide](user-guide.md#first-time-setup) covers the rest. Afterwards you may remove `SETUP_TOKEN`: setup is disabled for good once a passkey exists.

## Operations

**Health and logs.** `curl -s http://127.0.0.1:8787/api/health` shows the version, git SHA and configuration problems. Logs are one JSON object per line: `journalctl --user -u stoppeklokke` (Quadlet) or `journalctl -u stoppeklokke` (systemd). Podman also runs the image's health check: `podman healthcheck run stoppeklokke`.

**Backups.** The database is a single file in WAL mode; copy it with SQLite's own online backup so the copy is consistent while the server runs:

```sh
# Container: writes the backup next to the database, on the volume
podman exec stoppeklokke bun -e "new (require('bun:sqlite').Database)('/data/stoppeklokke.sqlite').run(\"VACUUM INTO '/data/backup-$(date +%F).sqlite'\")"
podman cp stoppeklokke:/data/backup-$(date +%F).sqlite .

# Option B: from the working directory
bun -e "new (require('bun:sqlite').Database)('data/stoppeklokke.sqlite').run(\"VACUUM INTO 'data/backup-$(date +%F).sqlite'\")"
```

Run that from a timer and copy the file off the server (restic, rsync, …). **Settings → Your data → Download export** in the app is a second, portable backup. To restore, stop the service, put the backup file in place as `stoppeklokke.sqlite` (remove any `-wal`/`-shm` files next to it) and start again.

**Upgrades.** Migrations run automatically at startup and are additive only, so an upgrade needs no manual step. Take a backup first; to roll back, start the previous version (it ignores the extra columns) or restore the backup.

**Lost all passkeys and recovery codes.** Delete the authentication data (time data is untouched), set a new `SETUP_TOKEN`, restart, and visit `/setup` again:

```sh
podman exec stoppeklokke bun -e "new (require('bun:sqlite').Database)('/data/stoppeklokke.sqlite').run('DELETE FROM passkeys; DELETE FROM sessions; DELETE FROM recovery_codes; DELETE FROM auth_challenges;')"
```

(For option B use the path `data/stoppeklokke.sqlite` and plain `bun -e …`.)

**Changing domain.** Passkeys are bound to `RP_ID`. After changing `ORIGIN`/`RP_ID`, reset the authentication data as above and register new passkeys; your data stays.

## Moving from Cloudflare

1. In the Cloudflare instance: **Settings → Your data → Download export**.
2. Set up the self-hosted instance as above, register a passkey and finish the setup wizard.
3. In the new instance: **Settings → Your data → Import a file**. Reports, locks and rates come out identical (the import is tested to round-trip).
4. Point DNS at your server. Passkeys are not part of the export (they are authentication data, not time data), so you register them again on the new instance, whether or not the domain stays the same.
5. Re-subscribe each device to notifications (push subscriptions are not exported), and recreate API tokens and webhooks.
