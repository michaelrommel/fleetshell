/// Small shared helpers used by both server.rs and tunnel.rs.
use tauri::{Emitter, Manager};

/// Show and focus the main window, restoring it if minimised.
/// Window placement is left entirely to the OS.
pub fn show_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
    }
}

/// Show the main window and tell the frontend to switch to `tab`.
pub fn navigate(app: &tauri::AppHandle, tab: &str) {
    show_window(app);
    app.emit("navigate", serde_json::json!({ "tab": tab })).ok();
}
