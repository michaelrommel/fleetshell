# FleetShell MDM portal -- container image.
#
# Build context is the REPO ROOT (see scripts/build_portal.sh), so all COPY
# paths are prefixed with fleetshell-portal/.
#
# The app is served by a custom entry (server.js) that wraps adapter-node's
# request handler and attaches the WebSocket server on the same port -- so the
# CMD is `node server.js`, not `node build/index.js`.

# -- Stage 1: builder ---------------------------------------------------------
# Full Node image so all devDependencies (Vite, Svelte compiler, TS) are present.
FROM node:22-alpine AS builder

WORKDIR /build

# Lockfile + manifest first so `npm ci` is cached until deps change.
COPY fleetshell-portal/package.json fleetshell-portal/package-lock.json ./
RUN npm ci

# Rest of the source tree, then compile (adapter-node -> build/).
COPY fleetshell-portal/ .

# BASE_PATH must match runtime; empty = site root (default). Override at build
# time only when deploying under a sub-path.
ARG BASE_PATH=""
ENV BASE_PATH=${BASE_PATH}
RUN npm run build


# -- Stage 2: runner ----------------------------------------------------------
# Minimal runtime; server.js + the postgres/redis/ws deps run in production.
FROM node:22-alpine

RUN adduser -D fleetshell
WORKDIR /fleetshell-portal

# Production dependencies only (manifests first for layer caching).
COPY --from=builder /build/package.json /build/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Compiled bundle + the custom server entry (+ its ws helper).
COPY --from=builder --chown=fleetshell:fleetshell /build/build ./build
COPY --from=builder --chown=fleetshell:fleetshell /build/server.js /build/ws-server.js ./

USER fleetshell

# -- Runtime configuration (override at deploy time) --------------------------
# Global plane (master data + authz):
#   GLOBAL_DB_HOST / GLOBAL_DB_PORT / GLOBAL_DB_NAME / GLOBAL_DB_USER / GLOBAL_DB_PASSWORD
# Regional plane (user PII + group membership):
#   LOCAL_DB_HOST / LOCAL_DB_PORT / LOCAL_DB_NAME / LOCAL_DB_USER / LOCAL_DB_PASSWORD
#   PGSSL=verify-full (prod, + PGSSLROOTCERT) | require | disable
# Auth / crypto:
#   SESSION_SECRET   -- cookie signing key (openssl rand -base64 32)
#   JWT_SECRET       -- tunnel + probe JWTs; MUST match the gateway's JWT_SECRET
# Valkey (classification / dtm / infoproxy / subscription spools + enrollment):
#   VALKEY_URL=rediss://host:6379   VALKEY_TLS_REJECT_UNAUTHORIZED=true (prod)
# adapter-node CSRF: ORIGIN = the public URL (e.g. https://portal.fleetshell.com)
# Optional: BASE_PATH (default empty = root), PUBLIC_CLIENT_API_PORT,
#   DOWNLOAD_* installer paths, PUBLIC_GITHUB_RELEASE_URL, CLIENT_CERT/CLIENT_KEY.

ENV PORT=3000 \
    HOST=0.0.0.0 \
    BASE_PATH="" \
    NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
