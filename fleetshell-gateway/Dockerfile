FROM rust:alpine AS builder
WORKDIR /workspace
COPY fleetshell-gateway /workspace/fleetshell-gateway
COPY Cargo.toml /workspace/Cargo.toml
# Create dummy folders/manifests for OTHER members listed in root Cargo.toml
RUN mkdir -p \
	/workspace/fleetshell-client/src-tauri/src && \
	echo -e '[package]\nname = "fleetshell-client"\nversion = "0.1.0"' > /workspace/fleetshell-client/src-tauri/Cargo.toml && \
	touch /workspace/fleetshell-client/src-tauri/src/lib.rs
RUN apk add --no-cache musl-dev openssl-dev openssl-libs-static protoc
RUN cargo build --release -p fleetshell-gateway --target x86_64-unknown-linux-musl

FROM alpine
WORKDIR /fleetshell-gateway
COPY --from=builder --chown=fleetshell:fleetshell /workspace/target/x86_64-unknown-linux-musl/release/fleetshell-gateway .
COPY fleetshell-gateway/scripts/run.sh .
RUN apk add --no-cache curl tcpdump procps jq
RUN adduser -D fleetshell
RUN chown fleetshell:fleetshell .
USER fleetshell
CMD [ "./run.sh" ]

