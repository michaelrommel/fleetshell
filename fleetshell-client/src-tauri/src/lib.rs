mod config;
mod guac_proxy;
mod portal;
mod server;
mod slot;
mod tunnel;
mod util;
mod zscaler;

use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_log::{Target, TargetKind};

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> config::AppConfig {
    config::load(&app)
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, config: config::AppConfig) -> Result<(), String> {
    config::save(&app, &config)
}

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

/// POST `{username, password}` as JSON to the configured portal URL and return
/// the raw response body (or a human-readable error string on failure).
#[tauri::command]
async fn enrollment_login(
    app: tauri::AppHandle,
    username: String,
    password: String,
) -> Result<String, String> {
    let cfg = config::load(&app);
    let url = format!("{}/api/login", cfg.portal_base_url.trim_end_matches('/'));

    log::info!("Enrollment: POST to {}", url);

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let body = serde_json::json!({ "username": username, "password": password });

    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    log::info!("Enrollment: response {} ({} bytes)", status, text.len());

    Ok(format!("HTTP {}\n\n{}", status, text))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── Single-instance guard ────────────────────────────────────────────────
    //
    // Covers both a deep-link launch (fleetshell:// in argv) and a plain
    // double-launch from the Start Menu (no argv URL).
    //
    // TCP-probe the API port first.  If something answers:
    //   • deep-link  → forward the URL to the running instance and exit.
    //   • normal     → ask the running instance to surface its window and exit.
    //
    // Fall through on probe failure or forward error so the user always
    // gets a working client.
    let args: Vec<String> = std::env::args().collect();
    let deep_link_url = args.get(1)
        .filter(|u| u.starts_with("fleetshell://"))
        .map(String::as_str);

    if probe_api_port() {
        eprintln!("[fleetshell] another instance detected on port {}", server::API_PORT);
        match deep_link_url {
            Some(url) => {
                eprintln!("[fleetshell] deep-link launch — forwarding to running instance");
                match forward_deep_link(url) {
                    ForwardResult::Forwarded        => { eprintln!("[fleetshell] forwarded — exiting"); return; }
                    ForwardResult::ForwardFailed(e) => { eprintln!("[fleetshell] forward failed ({e}) — handling locally"); }
                }
            }
            None => {
                eprintln!("[fleetshell] double-launch — asking running instance to show window");
                if show_running_instance() {
                    return;
                }
                eprintln!("[fleetshell] show request failed — continuing startup");
            }
        }
    }

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
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![get_config, save_config, get_log_history, enrollment_login])
        .setup(|app| {
            log::info!("FleetShell client starting up (pid {})", std::process::id());

            // ── Deep-link handler ────────────────────────────────────────────
            //
            // on_open_url fires when a fleetshell:// URL arrives AFTER startup
            // (forwarded from a second instance via POST /api/deep-link, or on
            // macOS / Linux where the OS delivers the URL to the running app).
            let dl_app = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    log::info!("Deep-link URL received via on_open_url: {}", url);
                    let app = dl_app.clone();
                    let url = url.clone();
                    tauri::async_runtime::spawn(async move {
                        portal::handle_deep_link(&app, url).await;
                    });
                }
            });

            // on_open_url only fires for events emitted AFTER the listener is
            // registered.  On a cold start (app launched directly by the OS
            // with the URL as a CLI argument) the deep-link plugin already
            // parsed the URL during its own setup() before our listener was
            // registered.  get_current() returns that buffered URL.
            match app.deep_link().get_current() {
                Ok(Some(urls)) => {
                    log::info!(
                        "Deep-link URL(s) found at startup (cold-start path): {:?}",
                        urls.iter().map(|u| u.as_str()).collect::<Vec<_>>()
                    );
                    for url in urls {
                        let h = app.handle().clone();
                        tauri::async_runtime::spawn(async move {
                            portal::handle_deep_link(&h, url).await;
                        });
                    }
                }
                Ok(None) => {
                    log::debug!("Deep-link: no URL present at startup (normal launch)");
                }
                Err(e) => {
                    log::warn!("Deep-link get_current() error: {}", e);
                }
            }
            // ── Axum API server ───────────────────────────────────────────
            let api_state = server::ApiState {
                app:           app.handle().clone(),
                gateway_path:  Arc::new(server::DEFAULT_GATEWAY_PATH.to_string()),
                slot_manager:  slot::SlotManager::new(),
                guac_sessions: Arc::new(tokio::sync::RwLock::new(
                    std::collections::HashMap::new()
                )),
            };
            let router = server::build_router(api_state);

            // Build the initial TLS acceptor from on-disk cert+key (if enrolled).
            // Wrapped in Arc<RwLock> so enrollment can hot-swap it without a restart.
            let cfg = config::load(app.handle());

            log::info!(
                "Startup: client_id={:?}  config_dir={}",
                cfg.client_id,
                app.handle().path().app_config_dir()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| "<unavailable>".to_string()),
            );

            let initial_acceptor = cfg.client_id.as_deref().and_then(|id| {
                let cert_path = config::cert_path(app.handle(), id);
                let key_path  = config::key_path(app.handle(), id);

                log::info!("Startup: cert expected at {}", cert_path.display());
                log::info!("Startup: key  expected at {}", key_path.display());

                let cert = match config::load_cert(app.handle(), id) {
                    Some(c) => c,
                    None    => {
                        // load_cert already logged the specific I/O error.
                        log::warn!("Startup: certificate missing — API will start in plain HTTP mode");
                        return None;
                    }
                };

                let key = match config::load_key(app.handle(), id) {
                    Some(k) => k,
                    None    => {
                        log::warn!("Startup: private key missing — API will start in plain HTTP mode");
                        return None;
                    }
                };

                match server::build_tls_acceptor(&cert, &key) {
                    Ok(a) => {
                        log::info!("Startup: TLS acceptor built for client_id={id}");
                        Some(a)
                    }
                    Err(e) => {
                        log::warn!("Startup: TLS acceptor build failed — API will start in plain HTTP mode: {e}");
                        None
                    }
                }
            });

            let is_tls    = initial_acceptor.is_some();
            let tls_state = Arc::new(tokio::sync::RwLock::new(initial_acceptor));
            // Register as Tauri managed state so portal.rs can promote HTTP → HTTPS
            // after enrollment without requiring a restart.
            app.manage(server::TlsState(tls_state.clone()));

            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::bind(("127.0.0.1", server::API_PORT))
                    .await
                    .expect("Failed to bind API server");

                if is_tls {
                    log::info!(
                        "API server listening on https://{}:{} (bound to 127.0.0.1)",
                        server::API_HOST,
                        server::API_PORT,
                    );
                } else {
                    log::info!(
                        "API server listening on http://127.0.0.1:{}",
                        server::API_PORT,
                    );
                }
                server::serve_adaptive(listener, router, tls_state).await;
            });

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

            app.manage(tray);

            // ── Close button → hide to tray ───────────────────────────────
            let window = app.get_webview_window("main").expect("main window not found");
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

// ── Single-instance helpers ──────────────────────────────────────────────────

enum ForwardResult {
    /// URL was delivered to the running instance; this process should exit.
    Forwarded,
    /// Forward attempt failed; handle the URL locally instead.
    ForwardFailed(String),
}

/// Returns `true` when a process is already listening on the API port.
///
/// Uses a 300 ms TCP connection timeout so a stale wslrelay or unrelated
/// service only blocks startup briefly if it happens to occupy the port.
fn probe_api_port() -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", server::API_PORT).parse().unwrap(),
        Duration::from_millis(300),
    ).is_ok()
}

/// Ask the running instance to bring its window to the front.
///
/// POSTs to `POST /api/show` (HTTPS-first, HTTP fallback).  Returns `true`
/// when the running instance acknowledged the request.
fn show_running_instance() -> bool {
    use std::time::Duration;
    let https_url = format!("https://{}:{}/api/show", server::API_HOST, server::API_PORT);
    let http_url  = format!("http://127.0.0.1:{}/api/show",              server::API_PORT);
    for url in [https_url.as_str(), http_url.as_str()] {
        if let Ok(resp) = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .and_then(|c| c.post(url).send())
        {
            if resp.status().is_success() { return true; }
        }
    }
    false
}

/// Forward a `fleetshell://` URL to the running instance via `POST /api/deep-link`.
///
/// Tries HTTPS first (enrolled instance) then plain HTTP (pre-enrollment).
/// Uses `reqwest::blocking` so this runs before the tokio runtime starts.
fn forward_deep_link(raw_url: &str) -> ForwardResult {
    use std::time::Duration;
    let body      = serde_json::json!({ "url": raw_url });
    let https_url = format!("https://{}:{}/api/deep-link", server::API_HOST, server::API_PORT);
    let http_url  = format!("http://127.0.0.1:{}/api/deep-link",              server::API_PORT);
    for url in [https_url.as_str(), http_url.as_str()] {
        let result = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .and_then(|c| c.post(url).json(&body).send());
        match result {
            Ok(resp) if resp.status().is_success() => return ForwardResult::Forwarded,
            Ok(resp) => return ForwardResult::ForwardFailed(
                format!("server returned HTTP {}", resp.status()),
            ),
            Err(_) => continue,
        }
    }
    ForwardResult::ForwardFailed("both https and http forward attempts failed".to_string())
}
