# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM rust:1-alpine AS builder

# musl-dev  — linker stubs for the musl C library (ring needs them)
# perl      — required by ring's build script
RUN apk add --no-cache musl-dev perl

WORKDIR /app

# Cache dependency compilation separately from source changes.
# Trick: copy manifests first, create a stub main, build deps, then overwrite.
COPY test-server/Cargo.toml ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs \
 && cargo build --release \
 && rm -rf src

# Now build the real source
COPY test-server/src ./src
# Touch main.rs so cargo knows it changed (otherwise it skips the re-link)
RUN touch src/main.rs && cargo build --release

# ── Stage 2: run ──────────────────────────────────────────────────────────────
FROM alpine:3

RUN apk add --no-cache ca-certificates openssh-server && \
	ssh-keygen -A && \
	mkdir -p /root/.ssh && \
	sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config

COPY test-server/scripts/authorized_keys /root/.ssh/authorized_keys
COPY test-server/scripts/run.sh /
COPY --from=builder /app/target/release/test-server /usr/local/bin/test-server

RUN chmod +x /run.sh

EXPOSE 8080 8443 22

CMD ["/run.sh"]
