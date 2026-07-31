/// Recording session metadata and job-file helpers.
///
/// # Flow
///
/// 1. The gateway builds a [`RecordingMeta`] once `guac::connect()` returns
///    (so the `conn_id` is known) and stores it alongside the parked guacd
///    stream.
///
/// 2. When the session truly ends — either because guacd closed the
///    connection, or because the park-grace timer fired without a reconnect —
///    the gateway calls [`write_job_file`].
///
/// 3. [`write_job_file`] writes `<jobs_path>/<safe_conn_id>.json`.  The file
///    appearing in the jobs directory is the inotify signal for `guacrecord`
///    to post-process the `.guac` recording.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

// ── Session counter ───────────────────────────────────────────────────────────

/// Monotonically increasing counter, incremented once per recorded session.
/// Combined with a millisecond timestamp it makes recording filenames unique
/// even if multiple sessions start within the same millisecond on the same
/// gateway instance.
static SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

// ── Metadata ──────────────────────────────────────────────────────────────────

/// Everything `guacrecord` needs to post-process one session.
#[derive(Debug, Clone, Serialize)]
pub struct RecordingMeta {
	/// guacd connection identifier (e.g. `$b916d7b8-6ff5-45dd-8103-f70897fe1556`).
	pub conn_id:    String,
	/// Full filesystem path to the `.guac` recording file.
	/// e.g. `/recordings/192.168.1.100/1748779380123`
	pub recording:  String,
	/// Target device IP address.
	pub target:     String,
	/// Guacamole protocol: `rdp`, `vnc`, or `ssh`.
	pub protocol:   String,
	/// Authenticated portal user from the JWT `sub` claim.
	pub user:       Option<String>,
	/// Session display width in pixels (used by `guacenc -s WxH`).
	pub width:      u32,
	/// Session display height in pixels.
	pub height:     u32,
	/// Session start timestamp (Unix milliseconds).
	pub started_ms: u64,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Current time as Unix milliseconds.
pub fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis() as u64
}

/// Generate a recording filename that is unique within this process.
///
/// Format: `<unix_ms>-<seq:04>.guac`
///
/// - The millisecond timestamp keeps filenames human-readable and sortable.
/// - The zero-padded sequence counter prevents collisions when two sessions
///   start within the same millisecond on the same gateway instance.
/// - Across process restarts the timestamp component differs (unless the
///   process restarts and a new session starts in the exact same millisecond
///   slot at the same sequence offset — astronomically unlikely).
pub fn new_recording_name() -> String {
	let ms  = now_ms();
	let seq = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
	format!("{}-{:04}.guac", ms, seq)
}

/// Write a job JSON file to `<jobs_path>/<safe_conn_id>.json`.
///
/// The `safe_conn_id` strips guacd's leading `$` so the filename is shell-safe.
/// `ended_ms` is written alongside the pre-existing `started_ms` so
/// `guacrecord` can log session duration.
pub async fn write_job_file(
	meta:      &RecordingMeta,
	jobs_path: &str,
	ended_ms:  u64,
) -> std::io::Result<()> {
	let payload = serde_json::json!({
		"conn_id":    meta.conn_id,
		"recording":  meta.recording,
		"target":     meta.target,
		"protocol":   meta.protocol,
		"user":       meta.user,
		"width":      meta.width,
		"height":     meta.height,
		"started_ms": meta.started_ms,
		"ended_ms":   ended_ms,
	});
	// Strip the leading '$' that guacd prepends to connection IDs so the
	// resulting filename is valid in every shell context.
	let safe_id = meta.conn_id.trim_start_matches('$');
	let path    = format!("{}/{}.json", jobs_path, safe_id);
	tokio::fs::write(&path, payload.to_string()).await
}
