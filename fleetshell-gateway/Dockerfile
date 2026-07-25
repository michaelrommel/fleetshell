# ── Stage 1: Rust builder ─────────────────────────────────────────────────────
FROM rust:alpine AS builder
WORKDIR /workspace
COPY fleetshell-gateway /workspace/fleetshell-gateway
COPY Cargo.toml /workspace/Cargo.toml
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

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
# Base on the official guacd image so we get guacd, FreeRDP, libvncclient,
# libssh2, and all their runtime libraries pre-built for Alpine — no
# compilation needed.  The gateway binary is a statically-linked musl binary
# that has no shared-library dependencies of its own.
#
# guacd binary  : /opt/guacamole/sbin/guacd
# guacd libs    : /opt/guacamole/lib  (LD_LIBRARY_PATH already set in image)
# guacd user    : guacd (UID 1000) — already created by base image
# netcat-openbsd: already present in base image (used for healthcheck)
FROM guacamole/guacd:1.5.0

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

# Copy the statically-linked gateway binary.
COPY --from=builder \
	/workspace/target/x86_64-unknown-linux-musl/release/fleetshell-gateway .

# Copy the start-up script.
COPY fleetshell-gateway/scripts/run.sh .
COPY target/x86_64-unknown-linux-musl/release/test-guac .
RUN chmod +x run.sh

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
