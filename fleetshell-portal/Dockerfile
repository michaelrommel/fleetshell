# ── Stage 1: builder ──────────────────────────────────────────────────────────
# Full Node.js image so all devDependencies (TypeScript, Vite, Svelte compiler…)
# are available for the build step.  Nothing from this layer ships in the final
# image.
FROM node:22-alpine AS builder

WORKDIR /build

# Copy the lock-file and manifest first so npm ci is cached as long as
# dependencies haven't changed, even if source files have.
COPY fleetshell-portal/package.json fleetshell-portal/package-lock.json ./

# Install every dependency (including devDeps — needed by Vite / svelte-check).
RUN npm ci

# Copy the rest of the source tree.
COPY fleetshell-portal/ .

# Compile the SvelteKit app with adapter-node.
# Output layout:
#   build/index.js      ← Node.js server entrypoint
#   build/handler.js    ← request handler (used by custom Node wrappers)
#   build/client/       ← static assets (JS bundles, CSS, hashed filenames)
#   build/server/       ← SSR server chunks
RUN npm run build


# ── Stage 2: runner ────────────────────────────────────────────────────────────
# Minimal Node.js runtime.  server.js (the custom entry point) uses the `ws`
# package at runtime, so we do need node_modules — but only production deps.
FROM node:22-alpine

# ── Non-root user ──────────────────────────────────────────────────────────────
RUN adduser -D fleetshell

WORKDIR /fleetshell-portal

# Install only production dependencies (just `ws` and its peers; all devDeps
# are excluded).  Copy manifests first so this layer is cached on dep changes.
COPY --from=builder /build/package.json /build/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# The compiled SvelteKit bundle.
COPY --from=builder --chown=fleetshell:fleetshell /build/build ./build
COPY ./dist/fleetshell-client_0.6.0_x64-setup.exe .
USER fleetshell

# ── Runtime configuration ──────────────────────────────────────────────────────
# Required — override these before deploying.
# The application will not start without PORTAL_USERNAME and PORTAL_PASSWORD.

# ── Credentials ───────────────────────────────────────────────────────────────
# PORTAL_USERNAME=admin
# PORTAL_PASSWORD=changeme

# ── Session ───────────────────────────────────────────────────────────────────
# HMAC-SHA256 secret used to sign session cookies.
# Generate a strong random value, e.g.:
#   openssl rand -base64 32
# PORTAL_SESSION_SECRET=change-me-in-production

# ── JWT ───────────────────────────────────────────────────────────────────
# HMAC-SHA256 secret used to sign probe JWT tokens.
# Must be the same value used by fleetshell-gateway if both services are deployed.
# Generate: openssl rand -base64 32
# JWT_SECRET=secret

# ── Downloads ───────────────────────────────────────────────────────────────────
# Absolute (or cwd-relative) path to each installer on disk.
# The logical download URL stays the same forever; to ship a new version just
# update the path here and restart the server — no rebuild needed.
#
# The file in static/ is served during development; point to a stable directory
# outside the build folder in production so binaries survive redeployments.
# DOWNLOAD_FLEETSHELL_CLIENT=/fleetshell-portal/fleetshell-client_0.5.0_x64-setup.exe
# DOWNLOAD_VNC_VIEWER=
# DOWNLOAD_TEAMVIEWER_CLIENT=
# DOWNLOAD_SSH_TERMINAL=

# ── Redis ───────────────────────────────────────────────────────────────────
# REDIS_URL=redis://localhost:6379

# ── Network ───────────────────────────────────────────────────────────────────
# The Node server listens on this host:port when started with `node build/index.js`.
# HOST=0.0.0.0
# PORT=3000

# ORIGIN is used by @sveltejs/adapter-node to determine the request URL origin
# for CSRF protection.  Set this to the public URL of the portal.
# Without this the adapter falls back to assuming HTTPS, which will cause
# CSRF false-positives on plain-HTTP setups.
# Examples:
#   ORIGIN=http://localhost:3000          (local development)
#   ORIGIN=https://portal.fleetshell.com (production)
# ORIGIN=http://localhost:3000
#
# BODY_SIZE_LIMIT — Optional.  adapter-node default is 512 kB.

ENV PORT=3000 \
	DOWNLOAD_FLEETSHELL_CLIENT=/fleetshell-portal/fleetshell-client_0.6.0_x64-setup.exe \
    NODE_ENV=production

EXPOSE 3000

CMD ["node", "build/index.js"]
