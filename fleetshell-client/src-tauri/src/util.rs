/// Small shared helpers used by both server.rs and tunnel.rs.
use tauri::{Emitter, Manager, PhysicalPosition};

/// Show and focus the main window, positioning it near the bottom-right corner
/// of the screen (i.e. close to the system tray area).
pub fn show_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        position_near_tray(&w);
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Show the main window and tell the frontend to switch to `tab`.
pub fn navigate(app: &tauri::AppHandle, tab: &str) {
    show_window(app);
    app.emit("navigate", serde_json::json!({ "tab": tab })).ok();
}

/// Move the window to the bottom-right corner of whichever monitor it currently
/// lives on, with a small margin from the edges to clear the taskbar and
/// desktop edge.
fn position_near_tray(w: &tauri::WebviewWindow) {
    // Prefer the monitor the window is associated with; fall back to primary.
    let monitor = match w.current_monitor() {
        Ok(Some(m)) => m,
        _ => match w.primary_monitor() {
            Ok(Some(m)) => m,
            _ => return,   // no monitor info available — leave position unchanged
        },
    };

    let win_size = match w.outer_size() {
        Ok(s)  => s,
        Err(_) => return,
    };

    let mon_size = monitor.size();
    let mon_pos  = monitor.position();

    // Leave a small gap from the right edge and enough room at the bottom to
    // clear the Windows taskbar (typically ~40–48 px on a 100 % display).
    const MARGIN_RIGHT:  i32 = 16;
    const MARGIN_BOTTOM: i32 = 52;

    let x = mon_pos.x + mon_size.width  as i32 - win_size.width  as i32 - MARGIN_RIGHT;
    let y = mon_pos.y + mon_size.height as i32 - win_size.height as i32 - MARGIN_BOTTOM;

    let _ = w.set_position(PhysicalPosition::new(x, y));
}
