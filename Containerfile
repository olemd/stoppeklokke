# SPDX-License-Identifier: AGPL-3.0-or-later
# Self-hosted Stoppeklokke (docs/self-hosting.md): one Bun process serving the
# API and the PWA, data in SQLite on the /data volume.
#
#   BUILDAH_FORMAT=docker podman build \
#     --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
#     --build-arg GIT_REVISION="$(git describe --always --dirty --abbrev=40)" \
#     --build-arg APP_VERSION="$(jq -r .version package.json)" \
#     -t stoppeklokke .
#
# BUILDAH_FORMAT=docker keeps the HEALTHCHECK (the OCI format drops it).

ARG BUN_VERSION=1.4.2

FROM docker.io/oven/bun:${BUN_VERSION} AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
ARG APP_VERSION=0.0.0-dev
ARG GIT_REVISION=unknown
ARG SOURCE_URL=https://github.com/olemd/stoppeklokke
# Version, SHA and source URL are baked into the PWA footer at build time.
ENV APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_REVISION} SOURCE_URL=${SOURCE_URL}
RUN bun scripts/i18n-index.ts \
 && bun --bun node_modules/vite/bin/vite.js build \
 && bun build src/platform/bun/server.ts --target bun --outfile dist/server/server.js

FROM docker.io/oven/bun:${BUN_VERSION}-slim
ARG BUILD_DATE=unknown
ARG GIT_REVISION=unknown
ARG APP_VERSION=0.0.0-dev
ARG SOURCE_URL=https://github.com/olemd/stoppeklokke
LABEL org.opencontainers.image.title="Stoppeklokke" \
      org.opencontainers.image.description="Single-user time tracking, self-hosted" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${GIT_REVISION}"
RUN printf 'build_date=%s\ngit_revision=%s\napp_version=%s\n' "${BUILD_DATE}" "${GIT_REVISION}" "${APP_VERSION}" > /etc/build-info \
 && mkdir -p /data && chown bun:bun /data
WORKDIR /app
COPY --from=build /src/dist/web ./web
COPY --from=build /src/dist/server/server.js ./server.js
COPY --from=build /src/migrations ./migrations
ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/stoppeklokke.sqlite \
    STATIC_DIR=/app/web \
    MIGRATIONS_DIR=/app/migrations \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_REVISION} \
    SOURCE_URL=${SOURCE_URL}
USER bun
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "server.js"]
