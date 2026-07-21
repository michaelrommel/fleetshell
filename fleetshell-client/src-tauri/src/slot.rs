//! Connection slot management.
//!
//! FleetShell reserves 16 loopback addresses (`127.0.0.2`–`127.0.0.17`) as
//! independent connection slots.  Every incoming tunnel request must claim a
//! free slot before it may bind listeners; the slot is released automatically
//! once no bytes have flowed for `idle_timeout` consecutive seconds.
//!
//! # Slot lifecycle
//!
//! ```text
//!  claim()     listeners bound   bytes flow       idle_timeout elapsed
//!    ↓              ↓                ↓                    ↓
//!  [free] ──→ [active] ──────→ [active/countdown] ──→ [free]
//!                                                   release()
//! ```

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::Emitter;
use tokio::task::JoinHandle;

// ── Constants / helpers ───────────────────────────────────────────────────────

/// Total number of independent connection slots.
pub const SLOT_COUNT: usize = 16;

/// Loopback IP for slot `idx` (0-based).
/// Slot 0 → `"127.0.0.2"`, slot 15 → `"127.0.0.17"`.
pub fn slot_ip(idx: usize) -> String {
	format!("127.0.0.{}", idx + 2)
}

/// DNS hostname for slot `idx`; matches the `*.client.fleetshell.com` wildcard cert.
/// Slot 0 → `"127-0-0-2.client.fleetshell.com"`.
pub fn slot_hostname(idx: usize) -> String {
	format!("127-0-0-{}.client.fleetshell.com", idx + 2)
}

/// Current Unix time in whole seconds — sufficient precision for idle detection.
pub fn now_secs() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0)
}

// ── Slot state ────────────────────────────────────────────────────────────────

struct SlotData {
	/// Updated to [`now_secs()`] whenever bytes pass through any tunnel on this slot.
	last_active: Arc<AtomicU64>,

	/// Handles for accept-loop tasks and individual tunnel-connection tasks.
	///
	/// The idle-monitor task's handle is intentionally **not** stored here so
	/// that [`SlotManager::release`] cannot abort it before it emits the final
	/// `"free"` frontend event.
	task_handles: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

/// Everything the caller needs after a successful [`SlotManager::claim`].
pub struct SlotHandle {
	/// 0-based slot index.
	pub idx: usize,

	/// Bind address, e.g. `"127.0.0.2"`.
	pub ip: String,

	/// Shared last-activity counter.
	/// Pass a clone to every task that moves bytes through the slot.
	pub last_active: Arc<AtomicU64>,

	/// Pool for accept-loop and per-connection task handles.
	/// Push every spawned handle here so [`SlotManager::release`] can abort them.
	pub task_handles: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

// ── Manager ───────────────────────────────────────────────────────────────────

/// Shared, async-safe registry of the 16 connection slots.
///
/// Wrap in `Arc` and clone into every component that needs to claim/release
/// slots or access the idle monitor.
pub struct SlotManager {
	slots: tokio::sync::Mutex<Vec<Option<SlotData>>>,
}

impl SlotManager {
	/// Create a new manager with all slots free.
	pub fn new() -> Arc<Self> {
		let slots = (0..SLOT_COUNT).map(|_| None).collect();
		Arc::new(Self {
			slots: tokio::sync::Mutex::new(slots),
		})
	}

	/// Claim the first free slot.
	///
	/// Returns `None` when all [`SLOT_COUNT`] slots are occupied.
	pub async fn claim(&self) -> Option<SlotHandle> {
		let mut guard = self.slots.lock().await;
		for (idx, entry) in guard.iter_mut().enumerate() {
			if entry.is_none() {
				let last_active  = Arc::new(AtomicU64::new(now_secs()));
				let task_handles = Arc::new(Mutex::new(Vec::new()));
				*entry = Some(SlotData {
					last_active:  last_active.clone(),
					task_handles: task_handles.clone(),
				});
				return Some(SlotHandle {
					idx,
					ip: slot_ip(idx),
					last_active,
					task_handles,
				});
			}
		}
		None
	}

	/// Abort all connection tasks for slot `idx` and mark the slot free.
	///
	/// Called by [`run_idle_monitor`] when the timeout fires.  The monitor's
	/// own handle is not in `task_handles`, so it is not aborted here; the
	/// monitor emits the final `"free"` Tauri event and exits on its own.
	pub async fn release(&self, idx: usize) {
		let mut guard = self.slots.lock().await;
		if let Some(data) = guard.get_mut(idx).and_then(|s| s.take()) {
			if let Ok(mut handles) = data.task_handles.lock() {
				for h in handles.drain(..) {
					h.abort();
				}
			}
		}
	}
}

// ── Idle monitor ──────────────────────────────────────────────────────────────

/// Runs as an independent tokio task; watches `last_active` and releases the
/// slot once `idle_timeout` consecutive idle seconds have elapsed.
///
/// Emits a `"slot-update"` Tauri event every second so the frontend
/// stopwatch animation stays current.
///
/// **Important:** do not store this task's [`JoinHandle`] in the slot's
/// `task_handles` pool — the monitor must not be aborted by [`SlotManager::release`]
/// before it can emit the final `"free"` event.
pub async fn run_idle_monitor(
	app:          tauri::AppHandle,
	slot_idx:     usize,
	last_active:  Arc<AtomicU64>,
	idle_timeout: u32,
	manager:      Arc<SlotManager>,
) {
	// Enforce a minimum of 10 s so a misconfigured value cannot spin-loop.
	let timeout_secs = u64::from(idle_timeout).max(10);

	let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(1));
	ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

	loop {
		ticker.tick().await;

		let now     = now_secs();
		let last    = last_active.load(Ordering::Relaxed);
		let elapsed = now.saturating_sub(last);

		if elapsed >= timeout_secs {
			log::info!(
				"Slot {} idle for {} s — releasing (timeout {} s)",
				slot_idx + 2,
				elapsed,
				timeout_secs,
			);
			manager.release(slot_idx).await;
			let _ = app.emit(
				"slot-update",
				serde_json::json!({
					"idx":      slot_idx,
					"status":   "free",
					"progress": 0.0_f64,
				}),
			);
			break;
		}

		let remaining = timeout_secs.saturating_sub(elapsed);
		let progress  = remaining as f64 / timeout_secs as f64;

		// "active" while traffic has flowed in the last second;
		// "countdown" once the slot goes quiet.
		let status = if elapsed <= 1 { "active" } else { "countdown" };

		let _ = app.emit(
			"slot-update",
			serde_json::json!({
				"idx":      slot_idx,
				"status":   status,
				"progress": progress,
			}),
		);
	}
}
