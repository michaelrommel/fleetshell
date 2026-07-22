mod config;
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
    // ── Single-instance deep-link forwarding ────────────────────────────────────────────
    //
    // On Windows, clicking a fleetshell:// link always spawns a NEW process
    // with the URL as its sole argument.  If our API server is already bound
    // on port 8080 another instance is running — forward the URL to it over
    // HTTP and exit immediately so only one instance ever runs.
    //
    // If no instance is running (port 8080 unreachable) we fall through to
    // the normal Tauri startup path.
    let args: Vec<String> = std::env::args().collect();
    if let Some(raw_url) = args.get(1).filter(|u| u.starts_with("fleetshell://")) {
        eprintln!("[fleetshell] launched with deep-link arg: {raw_url}");
        match try_forward_to_running_instance(raw_url) {
            ForwardResult::Forwarded => {
                eprintln!("[fleetshell] URL forwarded to running instance — exiting");
                return;
            }
            ForwardResult::NoRunningInstance => {
                eprintln!("[fleetshell] no running instance found — starting normally");
            }
            ForwardResult::ForwardFailed(e) => {
                eprintln!("[fleetshell] forward attempt failed ({e}) — handling locally");
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
                app:          app.handle().clone(),
                gateway_path: Arc::new(server::DEFAULT_GATEWAY_PATH.to_string()),
                slot_manager: slot::SlotManager::new(),
            };
            let router = server::build_router(api_state);

            // Build the initial TLS acceptor from on-disk cert+key (if enrolled).
            // Wrapped in Arc<RwLock> so enrollment can hot-swap it without a restart.
            let cfg = config::load(app.handle());
            let initial_acceptor = cfg.client_id.as_deref().and_then(|id| {
                let cert = config::load_cert(app.handle(), id)?;
                let key  = config::load_key(app.handle(), id)?;
                match server::build_tls_acceptor(&cert, &key) {
                    Ok(a) => {
                        log::info!("API server: TLS configured for client id={id}");
                        Some(a)
                    }
                    Err(e) => {
                        log::warn!("API server: TLS setup failed, falling back to plain HTTP: {e}");
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

// ── Single-instance forwarding helpers ───────────────────────────────────────────────────

enum ForwardResult {
    /// URL was delivered to the already-running instance; this process should exit.
    Forwarded,
    /// No instance is running on port 8080; normal startup should proceed.
    NoRunningInstance,
    /// The port was open but the HTTP call failed; handle locally.
    ForwardFailed(String),
}

/// Try to forward a `fleetshell://` URL to an already-running instance by
/// POSTing it to the local API server on port 8080.
///
/// Tries HTTPS first (post-enrollment) then plain HTTP (pre-enrollment).
/// Invalid certificates are accepted intentionally: the cert is issued for
/// `*.client.fleetshell.com`, not for `127.0.0.1`, but we trust our own
/// loopback listener.
///
/// Uses `reqwest::blocking` so this runs before the Tauri / tokio runtime
/// is started.  The timeout is intentionally short (300 ms) so a stale port
/// binding does not delay startup.
fn try_forward_to_running_instance(raw_url: &str) -> ForwardResult {
    use std::net::TcpStream;
    use std::time::Duration;

    // First check: is anything listening on our API port?
    if TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", server::API_PORT).parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_err()
    {
        return ForwardResult::NoRunningInstance;
    }

    let body = serde_json::json!({ "url": raw_url });

    // Try HTTPS first (running instance is enrolled), then plain HTTP
    // (running instance not yet enrolled).
    // HTTPS uses the DNS hostname so the wildcard cert validates correctly.
    // HTTP falls back for pre-enrollment instances that haven't got a cert yet.
    let https_url = format!("https://{}:{}/api/deep-link", server::API_HOST, server::API_PORT);
    let http_url  = format!("http://127.0.0.1:{}/api/deep-link", server::API_PORT);

    for url in [https_url.as_str(), http_url.as_str()] {
        let result = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .and_then(|c| c.post(url).json(&body).send());

        match result {
            Ok(resp) if resp.status().is_success() => return ForwardResult::Forwarded,
            Ok(resp) => {
                return ForwardResult::ForwardFailed(
                    format!("server returned HTTP {}", resp.status()),
                );
            }
            // Connection-level or TLS error — try the next scheme.
            Err(_) => continue,
        }
    }

    ForwardResult::ForwardFailed(
        "forward attempts failed on both https and http".to_string(),
    )
}
