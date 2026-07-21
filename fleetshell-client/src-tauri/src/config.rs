/// Persistent application configuration (stored as TOML in the OS app-config dir).
///
/// Path examples
///   Linux:   ~/.config/com.fleetshell.client/config.toml
///   Windows: C:\Users\<user>\AppData\Roaming\com.fleetshell.client\config\config.toml
use serde::{Deserialize, Serialize};
use tauri::Manager;

// ── Config struct ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// Base UI font size in pixels.  All component sizes scale from this value.
    pub font_size: u8,

    /// Full path to the TigerVNC viewer executable.
    /// Empty string = search the well-known names from PATH.
    #[serde(default)]
    pub vnc_viewer: String,

    /// Base URL of the FleetShell portal (no trailing slash).
    /// All API paths are constructed relative to this:
    ///   /api/login               ← enrollment tab
    ///   /api/client/probe/<id>   ← enroll deep-link step 1 (probe)
    ///   /api/cert/request        ← enroll deep-link step 2 (CSR)
    ///   /api/cert/status?id=<id> ← cert readiness poll
    ///   /api/cert/get?id=<id>    ← cert fetch
    ///   /api/cert/confirm        ← enroll deep-link step 3 (confirm)
    /// Set to e.g. http://localhost:5173 during development.
    #[serde(default = "default_portal_base_url")]
    pub portal_base_url: String,

    /// Idle-time threshold in seconds.  When no traffic has flowed through an
    /// active tunnel slot for this many seconds the listeners on that slot's
    /// loopback IP are torn down and the slot is released.
    #[serde(default = "default_idle_timeout")]
    pub idle_timeout: u32,

    /// Unique client ID assigned by the portal during the first successful
    /// enrollment handshake.  `None` until enrollment completes.
    #[serde(default)]
    pub client_id: Option<String>,
}

fn default_portal_base_url() -> String {
	"https://portal.fleetshell.com".to_string()
}

fn default_idle_timeout() -> u32 { 300 }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            font_size:       15,
            vnc_viewer:      String::new(),
            portal_base_url: default_portal_base_url(),
            idle_timeout:    default_idle_timeout(),
            client_id:       None,
        }
    }
}

// ── Load / save ───────────────────────────────────────────────────────────────

/// Load config from disk, falling back to [`AppConfig::default`] on any error.
pub fn load(app: &tauri::AppHandle) -> AppConfig {
    match std::fs::read_to_string(config_path(app)) {
        Ok(text) => toml::from_str(&text).unwrap_or_else(|e| {
            log::warn!("Config parse error, using defaults: {}", e);
            AppConfig::default()
        }),
        Err(_) => AppConfig::default(),
    }
}

/// Persist `config` to disk, creating parent directories as needed.
pub fn save(app: &tauri::AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = toml::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    log::debug!("Config saved to {}", path.display());
    Ok(())
}

// ── Certificate persistence ───────────────────────────────────────────────────

/// Persist the PEM certificate received from the portal.
///
/// Stored as `<id>.pem` in the app config directory:
///   Linux:   ~/.config/com.fleetshell.client/<id>.pem
///   Windows: …\AppData\Roaming\com.fleetshell.client\config\<id>.pem
pub fn save_cert(app: &tauri::AppHandle, id: &str, pem: &str) -> Result<(), String> {
	let path = cert_path(app, id);
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
	}
	std::fs::write(&path, pem).map_err(|e| e.to_string())?;
	log::debug!("Certificate saved to {}", path.display());
	Ok(())
}

/// Load the persisted PEM certificate for `id`.
///
/// Returns `None` if the file does not exist (not yet enrolled) or cannot be read.
pub fn load_cert(app: &tauri::AppHandle, id: &str) -> Option<String> {
	std::fs::read_to_string(cert_path(app, id)).ok()
}

/// Load the persisted PEM private key for `id`.
///
/// Returns `None` if the file does not exist or cannot be read.
pub fn load_key(app: &tauri::AppHandle, id: &str) -> Option<String> {
	std::fs::read_to_string(key_path(app, id)).ok()
}

/// Move all identity files for `id` into an `archive/` subdirectory.
///
/// Files considered: `<id>.crt`, `<id>.csr`, `<id>.key`.
/// Each existing file is renamed to
/// `archive/<id>_<unix_seconds>.<ext>` so that repeated re-enrollments
/// with the same ID do not silently overwrite earlier archives.
///
/// Failures are logged as warnings and do not stop the caller.
pub fn archive_identity(app: &tauri::AppHandle, id: &str) {
	let base        = app.path().app_config_dir().expect("app config dir unavailable");
	let archive_dir = base.join("archive");

	if let Err(e) = std::fs::create_dir_all(&archive_dir) {
		log::warn!("Could not create archive directory {}: {e}", archive_dir.display());
		return;
	}

	let ts = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0);

	for ext in ["pem", "csr", "key"] {
		let src = base.join(format!("{id}.{ext}"));
		if !src.exists() {
			continue;
		}
		let dst = archive_dir.join(format!("{id}_{ts}.{ext}"));
		match std::fs::rename(&src, &dst) {
			Ok(()) => log::info!("Archived {} → {}", src.display(), dst.display()),
			Err(e) => log::warn!("Could not archive {}: {e}", src.display()),
		}
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn config_path(app: &tauri::AppHandle) -> std::path::PathBuf {
	app.path()
		.app_config_dir()
		.expect("app config dir unavailable")
		.join("config.toml")
}

/// Path for `<id>.pem` — the signed certificate issued by the portal.
fn cert_path(app: &tauri::AppHandle, id: &str) -> std::path::PathBuf {
	app.path()
		.app_config_dir()
		.expect("app config dir unavailable")
		.join(format!("{id}.pem"))
}

/// Path for `<id>.csr` — the certificate signing request (Phase 2).
#[allow(dead_code)]
pub fn csr_path(app: &tauri::AppHandle, id: &str) -> std::path::PathBuf {
	app.path()
		.app_config_dir()
		.expect("app config dir unavailable")
		.join(format!("{id}.csr"))
}

/// Persist the PEM private key received from the portal.
///
/// Stored as `<id>.key` in the app config directory:
///   Linux:   ~/.config/com.fleetshell.client/<id>.key
///   Windows: …\AppData\Roaming\com.fleetshell.client\config\<id>.key
pub fn save_key(app: &tauri::AppHandle, id: &str, key: &str) -> Result<(), String> {
	let path = key_path(app, id);
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
	}
	std::fs::write(&path, key).map_err(|e| e.to_string())?;
	log::debug!("Private key saved to {}", path.display());
	Ok(())
}

/// Returns `true` when a private key for `id` is already stored on disk.
///
/// Used during enrollment to skip the key-fetch step when re-enrolling with
/// the same ID and the key is still present (e.g. after a cert rotation).
pub fn has_key(app: &tauri::AppHandle, id: &str) -> bool {
	key_path(app, id).exists()
}

/// Path for `<id>.key` — the private key.
pub fn key_path(app: &tauri::AppHandle, id: &str) -> std::path::PathBuf {
	app.path()
		.app_config_dir()
		.expect("app config dir unavailable")
		.join(format!("{id}.key"))
}
