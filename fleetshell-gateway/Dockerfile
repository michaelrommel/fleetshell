# ── Stage 1: Rust builder ─────────────────────────────────────────────────────
FROM rust:alpine AS builder
WORKDIR /workspace
COPY fleetshell-gateway /workspace/fleetshell-gateway
COPY Cargo.toml  /workspace/Cargo.toml
COPY Cargo.lock  /workspace/Cargo.lock
# Create dummy stubs for other workspace members so Cargo does not complain
# about missing members referenced in the root Cargo.toml.
RUN mkdir -p \
	/workspace/fleetshell-client/src-tauri/src && \
	echo -e '[package]\nname = "fleetshell-client"\nversion = "0.1.0"' > /workspace/fleetshell-client/src-tauri/Cargo.toml && \
	touch /workspace/fleetshell-client/src-tauri/src/lib.rs
RUN mkdir -p /workspace/test-guac/src && \
	printf '[package]\nname = "test-guac"\nversion = "0.1.0"\nedition = "2021"\n' \
		> /workspace/test-guac/Cargo.toml && \
	echo 'fn main() {}' > /workspace/test-guac/src/main.rs
RUN apk add --no-cache musl-dev openssl-dev openssl-libs-static protoc
RUN cargo build --release -p fleetshell-gateway --target x86_64-unknown-linux-musl

# ── Stage 2: build guacenc ───────────────────────────────────────────────────
# guacenc converts .guac session recordings to MP4/M4V video.
# The guacamole/guacd base image does not ship guacenc because it requires
# FFmpeg at build time (a large dep not needed by guacd itself).
# We compile it here from the same 1.6.0 source tarball used by the base
# image; only libguac + guacenc are built — protocol plugins (FreeRDP, SSH,
# VNC) are auto-disabled when their dev headers are absent.
#
# IMPORTANT: base this stage on guacamole/guacd:1.6.0 (not bare alpine) so
# that `apk add ffmpeg-dev` installs the same FFmpeg major version as the
# `apk add ffmpeg` in the runtime stage.  Both stages share the same Alpine
# package repository, which guarantees ABI-compatible library SONAMES.
FROM guacamole/guacd:1.6.0 AS guacenc-builder

USER root
RUN apk add --no-cache \
	build-base pkgconfig wget \
	# guacenc renders the recording canvas with Cairo, encodes with FFmpeg
	cairo-dev ffmpeg-dev \
	# libguac hard deps: SSL (cert handling), JPEG + PNG (frame codecs)
	openssl-dev libjpeg-turbo-dev libpng-dev

ARG GUAC_VER=1.6.0
# Download the official Apache source tarball and build in one layer to
# keep the builder stage cache small.
RUN wget -qO- \
		"https://downloads.apache.org/guacamole/${GUAC_VER}/source/guacamole-server-${GUAC_VER}.tar.gz" \
		| tar -xz -C /tmp \
	&& cd /tmp/guacamole-server-${GUAC_VER} \
	# Released tarballs ship a pre-generated configure script.
	# configure auto-detects available libs; missing protocol headers
	# (FreeRDP etc.) are silently skipped — libguac and guacenc still build.
	&& ./configure --prefix=/opt/guacenc \
	&& make -C src/libguac  all install \
	&& make -C src/guacenc  all install \
	&& strip /opt/guacenc/bin/guacenc

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
# Base on the official guacd image so we get guacd, FreeRDP, libvncclient,
# libssh2, and all their runtime libraries pre-built for Alpine — no
# compilation needed.  The gateway binary is a statically-linked musl binary
# that has no shared-library dependencies of its own.
#
# guacd binary  : /opt/guacamole/sbin/guacd
# guacd libs    : /opt/guacamole/lib  (LD_LIBRARY_PATH already set in image)
# guacd user    : guacd (UID 1000) — already created by base image
# netcat-openbsd: already present in base image (used for healthcheck)
FROM guacamole/guacd:1.6.0

USER root
WORKDIR /fleetshell-gateway

# Extra tools:
#   tini            — minimal init (PID 1); forwards SIGTERM to children and
#                     reaps zombies.  Without it a shell as PID 1 ignores
#                     SIGTERM while blocked in `wait`, so ECS can only SIGKILL.
#   curl jq         — ECS task-metadata fetch in run.sh
#   iproute2        — `ip addr` for GATEWAY_PRIVATE_IP detection
#   tcpdump procps  — diagnostics / debugging
# netcat-openbsd is already in the guacd base image.
RUN apk add --no-cache tini curl jq iproute2 tcpdump procps

# FFmpeg shared libraries needed by guacenc at runtime.
# (guacd itself does not use FFmpeg; this is the only reason it's added.)
RUN apk add --no-cache ffmpeg

# guacenc: convert .guac recordings to MP4/M4V.  Typical usage:
#   guacenc -s 1920x1080 /recordings/<ip>/session.guac session.m4v
# guacenc is linked against libguac.so.0 which lives in /opt/guacamole/lib/;
# that path is already on LD_LIBRARY_PATH in the base image.
COPY --from=guacenc-builder /opt/guacenc/bin/guacenc /usr/local/bin/guacenc

# Copy the statically-linked gateway binary.
COPY --from=builder \
	/workspace/target/x86_64-unknown-linux-musl/release/fleetshell-gateway .

# Copy the recording post-processor.
COPY --from=builder \
	/workspace/target/x86_64-unknown-linux-musl/release/guacrecord .

# Copy the start-up script.
COPY fleetshell-gateway/scripts/run.sh .
COPY target/x86_64-unknown-linux-musl/release/test-guac .
RUN chmod +x run.sh

# Create the drive-sharing buffer directory used by guacd for RDP file
# transfer. guacd runs as user 'guacd' (UID 1000) so it needs write access.
# drive-create-path=true in the guacd connect instruction will create
# per-session sub-directories automatically under this root.
RUN mkdir -p /guac/drives && chown -R guacd:guacd /guac

# Create the session-recording directory and jobs queue used by guacd and
# guacrecord.  Structure:
#   /recordings/<target_ip>/<name>      ← guacd writes .guac files here
#   /recordings/jobs/<conn_id>.json     ← gateway writes job descriptors
#   /recordings/jobs/done/<conn_id>.json ← guacrecord moves completed jobs
# Mount an EFS volume at /guac in production (same share as
# /guac/drives, different top-level directory) so recordings and job files
# persist across deployments and are visible to all container instances.
RUN mkdir -p /guac/recordings/jobs/done \
    && chown -R guacd:guacd /guac/recordings

# Hand ownership of the working directory to the unprivileged guacd user.
RUN chown -R guacd:guacd /fleetshell-gateway

# Drop to the unprivileged guacd user (UID 1000, already created by base image).
USER guacd

# tini as PID 1:
#   - forwards SIGTERM/SIGINT to run.sh (and via run.sh's trap to its children)
#   - reaps any zombie child processes
# The base image's ENTRYPOINT (direct guacd launch) is replaced here because
# run.sh manages guacd as a child process alongside the gateway binary.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./run.sh"]
