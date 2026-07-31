#!/bin/sh
# run.sh — Start guacd (loopback-only) then fleetshell-gateway.
#
# Process model:
#   tini (PID 1) → run.sh → guacd (background child)
#                         → fleetshell-gateway (background child, awaited)
#
#   tini forwards SIGTERM from ECS to run.sh.  run.sh's trap then sends
#   SIGTERM to both children and waits for them before exiting.
#   Without tini, a shell as PID 1 ignores SIGTERM while blocked in `wait`
#   and the task can only be stopped by SIGKILL.
#
# Environment variables (all optional):
#   GUACD_LOG_LEVEL     — guacd verbosity: trace|debug|info|warning|error
#                         default: info
#   GATEWAY_INTERACTIVE — set to "true" to skip starting the gateway binary
#                         (useful for shell-level debugging inside the container)

# ── 1. Start guacd in foreground mode as a background child ──────────────────
# -f  : stay in foreground (do not daemonise) so we can track the PID
# -b  : bind to loopback — guacd is an internal service; never expose port 4822
# -L  : log level (overridable via GUACD_LOG_LEVEL env var)
echo "[run.sh] starting guacd on 127.0.0.1:4822"
/opt/guacamole/sbin/guacd -f -b 127.0.0.1 -L "${GUACD_LOG_LEVEL:-info}" &
GUACD_PID=$!

# ── 2. Wait for guacd to accept connections (timeout: 15 s) ──────────────────
i=0
until nc -z 127.0.0.1 4822 2>/dev/null; do
	i=$((i + 1))
	if [ "$i" -ge 15 ]; then
		echo "[run.sh] ERROR: guacd did not start within 15 seconds" >&2
		kill "$GUACD_PID" 2>/dev/null
		exit 1
	fi
	sleep 1
done
echo "[run.sh] guacd ready (PID $GUACD_PID)"

# ── 3. ECS task metadata ──────────────────────────────────────────────────────
if [ -n "$ECS_CONTAINER_METADATA_URI_V4" ]; then
	METADATA=$(curl -sf "$ECS_CONTAINER_METADATA_URI_V4/task" || echo '{}')
	TASK_ARN=$(echo "$METADATA" | jq -r '.TaskARN // empty')
	TASK_ID=$(echo "$TASK_ARN" | awk -F/ '{print $NF}')
	GATEWAY_PRIVATE_IP=$(ip -4 addr show dev eth1 2>/dev/null \
		| awk '/inet /{gsub(/\/.*/, "", $2); print $2; exit}')
	export GATEWAY_INSTANCE_ID="$TASK_ID"
	export GATEWAY_PRIVATE_IP
fi

# Advertise the guacd address so the gateway binary can read it later.
export GUACD_ADDR="127.0.0.1:4822"

# Work around a reqsign bug: when AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is
# set, reqsign incorrectly prepends ECS_CONTAINER_METADATA_URI (the task
# metadata endpoint) instead of the fixed credential base http://169.254.170.2.
# Setting AWS_CONTAINER_CREDENTIALS_FULL_URI makes reqsign skip that path
# entirely and use the correct URL directly.
if [ -n "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}" ] && [ -z "${AWS_CONTAINER_CREDENTIALS_FULL_URI}" ]; then
	export AWS_CONTAINER_CREDENTIALS_FULL_URI="http://169.254.170.2${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}"
	echo "[run.sh] set AWS_CONTAINER_CREDENTIALS_FULL_URI=${AWS_CONTAINER_CREDENTIALS_FULL_URI}"
fi

# ── 4. Interactive / debug mode ───────────────────────────────────────────────
if [ "${GATEWAY_INTERACTIVE}" = "true" ]; then
	echo "[run.sh] GATEWAY_INTERACTIVE=true — gateway not started."
	echo "[run.sh] guacd is running on 127.0.0.1:4822 (PID $GUACD_PID)."
	echo "[run.sh] Test with: nc 127.0.0.1 4822  (expect Guacamole handshake)"
	sleep infinity
fi

# ── 5. Signal handler — forward TERM/INT to both children ─────────────────────
shutdown() {
	echo "[run.sh] shutdown signal received — stopping gateway, guacrecord, and guacd" >&2
	kill "$GATEWAY_PID" "$GUACRECORD_PID" "$GUACD_PID" 2>/dev/null
	wait "$GATEWAY_PID" "$GUACRECORD_PID" "$GUACD_PID" 2>/dev/null
	exit 0
}

# ── 6. Start fleetshell-gateway ───────────────────────────────────────────────
echo "[run.sh] starting fleetshell-gateway"
./fleetshell-gateway &
GATEWAY_PID=$!

# ── 7. Start guacrecord (if recording is configured) ───────────────────────────
# Derive the jobs directory the same way config.rs does:
#   1. Explicit GUACD_JOBS_PATH, or
#   2. ${GUACD_RECORDING_PATH}/jobs
if [ -n "${GUACD_JOBS_PATH}" ]; then
	JOBS_DIR="${GUACD_JOBS_PATH}"
elif [ -n "${GUACD_RECORDING_PATH}" ]; then
	JOBS_DIR="${GUACD_RECORDING_PATH}/jobs"
else
	JOBS_DIR=""
fi

if [ -n "${JOBS_DIR}" ]; then
	mkdir -p "${JOBS_DIR}/done"
	echo "[run.sh] starting guacrecord watching ${JOBS_DIR}"
	./guacrecord "${JOBS_DIR}" &
	GUACRECORD_PID=$!
else
	echo "[run.sh] GUACD_RECORDING_PATH not set — guacrecord not started"
	GUACRECORD_PID=""
fi

# Install the signal trap now that we know all PIDs.
trap shutdown INT TERM

# ── 8. Wait for gateway to exit ───────────────────────────────────────────────
# wait returns the exit code of the child.  If the gateway crashes or exits
# cleanly, we stop guacd and exit with the same code so ECS can restart the
# task if needed.
wait "$GATEWAY_PID"
GATEWAY_EXIT=$?

echo "[run.sh] fleetshell-gateway exited (code $GATEWAY_EXIT) — stopping guacd" >&2
kill "$GUACD_PID" 2>/dev/null
wait "$GUACD_PID" 2>/dev/null
exit "$GATEWAY_EXIT"
