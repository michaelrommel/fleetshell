use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_log::{Target, TargetKind};

#[tauri::command]
fn get_log_history(app: tauri::AppHandle, lines: usize) -> Result<Vec<String>, String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let log_file = log_dir.join("fleetshell-client.log");

    if !log_file.exists() {
        return Ok(vec![]);
    }

    let content = std::fs::read_to_string(&log_file).map_err(|e| e.to_string())?;
    let all_lines: Vec<&str> = content.lines().collect();
    let start = all_lines.len().saturating_sub(lines);
    Ok(all_lines[start..].iter().map(|s| s.to_string()).collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("fleetshell-client".into()),
                    }),
                    Target::new(TargetKind::Webview),
                ])
                .level(log::LevelFilter::Debug)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![get_log_history])
        .setup(|app| {
            log::info!("FleetShell client starting up");

            // ── Tray icon ─────────────────────────────────────────────────
            let open_item = MenuItem::with_id(app, "open", "Open FleetShell", true, None::<&str>)?;
            let sep       = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu      = Menu::with_items(app, &[&open_item, &sep, &quit_item])?;

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("no window icon configured"))
                .tooltip("FleetShell")
                .menu(&menu)
                .show_menu_on_left_click(false)
                // Context-menu actions
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        log::info!("Quit requested from tray");
                        app.exit(0);
                    }
                    _ => {}
                })
                // Left-click: toggle window visibility
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            match w.is_visible() {
                                Ok(true) => { let _ = w.hide(); }
                                _        => { let _ = w.show(); let _ = w.set_focus(); }
                            }
                        }
                    }
                })
                .build(app)?;

            // Keep the tray icon alive for the duration of the app.
            app.manage(tray);

            // ── Close button → hide to tray ───────────────────────────────
            let window = app.get_webview_window("main")
                .expect("main window not found");
            let w = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = w.hide();
                    api.prevent_close();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
