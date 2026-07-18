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
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            font_size:  15,
            vnc_viewer: String::new(),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

fn config_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .expect("app config dir unavailable")
        .join("config.toml")
}
