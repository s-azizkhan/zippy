//! Shell around the Node sidecar (apps/server). Owns the DB choice: `config.json` `databaseUrl`
//! if set, otherwise a built-in Postgres. The server rewrites config.json and exits to switch DBs.
use std::{
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};

use postgresql_embedded::{PostgreSQL, Settings};
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, WindowEvent, Wry,
};
use tokio::{net::TcpStream, process::Command, sync::Mutex, time::sleep};

// Debug builds get their own ports + data dir so they run beside the installed app.
const DEV: bool = cfg!(debug_assertions);
const PORT: u16 = if DEV { 3312 } else { 3311 }; // off the web dev server's 3301
const PG_PORT: u16 = if DEV { 54330 } else { 54329 };

#[derive(Default)]
struct Shared {
    quitting: AtomicBool,
    pid: AtomicU32,
    pg: Mutex<Option<PostgreSQL>>,
    status: std::sync::Mutex<String>,
    fails: AtomicU32,
    reset: AtomicBool,
}

impl Shared {
    fn say(&self, msg: impl Into<String>) {
        *self.status.lock().unwrap() = msg.into();
    }
}

/// Splash polls this: (what we're doing / what broke, consecutive failures).
#[tauri::command]
fn status(st: tauri::State<'_, Arc<Shared>>) -> (String, u32) {
    (st.status.lock().unwrap().clone(), st.fails.load(Ordering::SeqCst))
}

/// Last resort when the built-in DB won't start: erase it and start fresh.
#[tauri::command]
fn reset_builtin_db(st: tauri::State<'_, Arc<Shared>>) {
    st.reset.store(true, Ordering::SeqCst);
}

/// Release: node + bundles from `scripts/bundle.mjs` in Resources. Debug: live repo sources via tsx.
fn server_cmd(app: &AppHandle, data: &Path) -> Command {
    let mut cmd;
    if DEV {
        let server = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server");
        cmd = Command::new("node");
        cmd.args(["--import", "tsx", "src/index.ts"]).current_dir(&server).env("ZIPPY_WEB_DIST", server.join("../web/dist"));
    } else {
        let res = app.path().resource_dir().expect("resource dir").join("resources");
        cmd = Command::new(res.join("node"));
        cmd.arg(res.join("server.mjs"))
            .current_dir(data)
            .env("ZIPPY_WEB_DIST", res.join("web"))
            .env("ZIPPY_MIGRATIONS", res.join("migrations"))
            .env("ZIPPY_ADAPTER", res.join("adapter.mjs"))
            .env("ZIPPY_LOGS", data.join("logs"));
    }
    cmd
}

/// Finder-launched apps get a bare PATH; ask the login shell for the real one (claude, git, gh, node).
fn login_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    std::process::Command::new(shell)
        .args(["-ilc", "printf '\\n%s' \"$PATH\""])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().last().map(str::to_owned))
        .filter(|p| p.contains('/'))
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

async fn embedded_url(st: &Shared, data: &Path) -> Result<String, postgresql_embedded::Error> {
    let mut slot = st.pg.lock().await;
    if slot.is_none() {
        let dir = data.join("pg");
        let pgpass = dir.join(".pgpass");
        let mut settings = Settings {
            installation_dir: dir.join("bin"),
            data_dir: dir.join("data"),
            password_file: pgpass.clone(),
            port: PG_PORT,
            temporary: false,
            ..Default::default()
        };
        // The cluster keeps the password it was created with; a fresh random one would be rejected.
        if let Ok(pw) = std::fs::read_to_string(&pgpass) {
            settings.password = pw.trim().to_owned();
        }
        let mut pg = PostgreSQL::new(settings);
        st.say("Setting up database (first run downloads Postgres, about a minute)…");
        pg.setup().await?;
        st.say("Starting database…");
        pg.start().await?;
        *slot = Some(pg);
    }
    let pg = slot.as_ref().unwrap();
    if !pg.database_exists("zippy").await? {
        pg.create_database("zippy").await?;
    }
    Ok(pg.settings().url("zippy"))
}

async fn wait_port() -> bool {
    for _ in 0..120 {
        if TcpStream::connect(("127.0.0.1", PORT)).await.is_ok() {
            return true;
        }
        sleep(Duration::from_millis(500)).await;
    }
    false
}

async fn supervise(app: AppHandle, st: Arc<Shared>) {
    let data = app.path().app_data_dir().expect("app data dir").join(if DEV { "dev" } else { "" });
    let _ = std::fs::create_dir_all(&data);
    let cfg = data.join("config.json");
    let path = login_path();
    let mut shown = false;

    while !st.quitting.load(Ordering::SeqCst) {
        if st.reset.swap(false, Ordering::SeqCst) {
            st.say("Resetting built-in database…");
            if let Some(pg) = st.pg.lock().await.take() {
                let _ = pg.stop().await;
            }
            let _ = std::fs::remove_dir_all(data.join("pg/data"));
            let _ = std::fs::remove_file(data.join("pg/.pgpass"));
            st.fails.store(0, Ordering::SeqCst);
        }
        let custom = std::fs::read_to_string(&cfg)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v["databaseUrl"].as_str().map(str::to_owned));
        let (url, mode) = match custom {
            Some(u) => (u, "custom"),
            None => match embedded_url(&st, &data).await {
                Ok(u) => (u, "embedded"),
                Err(e) => {
                    eprintln!("built-in postgres failed: {e}");
                    st.fails.fetch_add(1, Ordering::SeqCst);
                    st.say(format!("Database failed: {e}. Retrying…"));
                    sleep(Duration::from_secs(3)).await;
                    continue;
                }
            },
        };

        st.fails.store(0, Ordering::SeqCst);
        st.say("Starting server…");
        let child = server_cmd(&app, &data)
            .env("PATH", &path)
            .env("PORT", PORT.to_string())
            .env("WEB_URL", format!("http://127.0.0.1:{PORT}"))
            .env("DATABASE_URL", url)
            .env("ZIPPY_DB_MODE", mode)
            .env("ZIPPY_CONFIG", &cfg)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                eprintln!("cannot start node: {e}");
                st.fails.fetch_add(1, Ordering::SeqCst);
                st.say(format!("Can't start server: {e}"));
                sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        st.pid.store(child.id().unwrap_or(0), Ordering::SeqCst);

        if !shown {
            st.say("Waiting for server…");
        }
        if !shown && wait_port().await {
            st.say("Opening Zippy…");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.navigate(format!("http://127.0.0.1:{PORT}").parse().unwrap());
                shown = true;
            }
        }
        let _ = child.wait().await;
        st.pid.store(0, Ordering::SeqCst);
        sleep(Duration::from_millis(500)).await;
    }
}

#[derive(serde::Deserialize, PartialEq, Default)]
struct Tray {
    inbox: usize,
    running: Vec<Run>,
}

#[derive(serde::Deserialize)]
struct Poll {
    #[serde(flatten)]
    tray: Tray,
    notes: Vec<Note>,
}

#[derive(serde::Deserialize)]
struct Note {
    title: String,
    body: String,
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[derive(serde::Deserialize, PartialEq)]
struct Run {
    label: String,
    path: String,
}

fn tray_menu(app: &AppHandle, t: &Tray) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    let n = t.running.len();
    let head = match n {
        0 => "No Zippers running".to_owned(),
        1 => "1 Zipper running".to_owned(),
        _ => format!("{n} Zippers running"),
    };
    menu.append(&MenuItem::new(app, head, false, None::<&str>)?)?;
    for r in &t.running {
        let label: String = r.label.chars().take(60).collect();
        menu.append(&MenuItem::with_id(app, format!("nav:{}", r.path), label, true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "capture", "New issue…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "nav:/inbox", format!("Inbox ({})", t.inbox), true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "open", "Open Zippy", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Zippy", true, None::<&str>)?)?;
    Ok(menu)
}

/// Show the window; `path` routes the SPA in place (react-router listens to popstate).
fn show(app: &AppHandle, path: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if let Some(p) = path {
            let _ = w.eval(format!("history.pushState(null, '', {p:?}); dispatchEvent(new PopStateEvent('popstate'))"));
        }
    }
}

/// Leaving Zippy's origin goes to the default browser. Only http(s)/mailto: agent-written links can't launch other handlers.
fn stays_in_app(url: &tauri::Url) -> bool {
    let local = url.scheme() == "tauri" || url.scheme() == "about" || (url.host_str() == Some("127.0.0.1") && url.port() == Some(PORT));
    if !local && matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = std::process::Command::new("open").arg(url.as_str()).spawn();
    }
    local
}

/// `zippy://settings?linear=connected` → full load of `/settings?linear=connected`, so data is fresh.
fn open_deep_link(app: &AppHandle, url: &tauri::Url) {
    let Some(rest) = url.as_str().strip_prefix("zippy://") else { return };
    show(app, None);
    if let (Some(w), Ok(to)) = (app.get_webview_window("main"), format!("http://127.0.0.1:{PORT}/{rest}").parse()) {
        let _ = w.navigate(to);
    }
}

/// Floating capture window (global hotkey). Hidden, not destroyed, so the next open is instant.
fn capture_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("capture") {
        return Ok(w);
    }
    tauri::WebviewWindowBuilder::new(app, "capture", tauri::WebviewUrl::App("capture.html".into()))
        .title("New issue")
        .inner_size(560.0, 260.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(false)
        .build()
}

/// Prefill the body with the clipboard when it looks like an error or log, not a URL or a word.
fn clipboard_hint(app: &AppHandle) -> String {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let text = app.clipboard().read_text().unwrap_or_default();
    let loggy = text.contains('\n') || ["error", "exception", "traceback", "fail", "panic"].iter().any(|k| text.to_lowercase().contains(k));
    if !loggy || text.len() > 20_000 {
        return String::new();
    }
    format!("```\n{}\n```", text.trim())
}

fn capture_open(app: &AppHandle) {
    use tauri::Emitter;
    if let Ok(w) = capture_window(app) {
        let _ = w.emit("capture:open", clipboard_hint(app));
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn capture_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.hide();
    }
}

/// The capture page can't fetch the server itself (tauri:// origin, no CORS), so post from here.
#[tauri::command]
async fn capture_submit(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let res = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{PORT}/api/quick"))
        .json(&serde_json::json!({ "title": title, "body": body }))
        .send()
        .await
        .map_err(|_| "Zippy server is not running yet".to_string())?;
    let ok = res.status().is_success();
    let v: serde_json::Value = res.json().await.unwrap_or_default();
    if !ok {
        return Err(v["error"].as_str().unwrap_or("could not file issue").to_owned());
    }
    notify(&app, "Issue filed", &format!("{} {}", v["identifier"].as_str().unwrap_or(""), v["title"].as_str().unwrap_or("")));
    Ok(())
}

/// config.json `hotkey`: absent = default, `null` = off. Settings writes it; we re-read on each tray poll.
fn config_hotkey(app: &AppHandle) -> Option<String> {
    let cfg = app.path().app_data_dir().expect("app data dir").join(if DEV { "dev/config.json" } else { "config.json" });
    std::fs::read_to_string(&cfg)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|v| v["hotkey"].as_str().map(str::to_owned))
        .unwrap_or(Some("CmdOrCtrl+Shift+Z".into()))
}

fn apply_hotkey(app: &AppHandle, hk: Option<&str>) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let _ = app.global_shortcut().unregister_all();
    if let Some(hk) = hk {
        if let Err(e) = app.global_shortcut().on_shortcut(hk, |app, _, e| {
            if e.state() == ShortcutState::Pressed {
                capture_open(app);
            }
        }) {
            eprintln!("hotkey {hk} not registered: {e}");
        }
    }
}

async fn poll_tray(app: AppHandle) {
    let mut last: Option<Tray> = None;
    let mut hotkey = config_hotkey(&app);
    apply_hotkey(&app, hotkey.as_deref());
    loop {
        let hk = config_hotkey(&app);
        if hk != hotkey {
            apply_hotkey(&app, hk.as_deref());
            hotkey = hk;
        }
        // Server down (starting, or restarting on a DB switch): keep the last state rather than report every chat as finished.
        let poll = match reqwest::get(format!("http://127.0.0.1:{PORT}/api/tray")).await {
            Ok(r) => r.json::<Poll>().await.ok(),
            Err(_) => None,
        };
        if let Some(Poll { tray: t, notes }) = poll {
            for n in &notes {
                notify(&app, &n.title, &n.body);
            }
            if let Some(prev) = &last {
                for r in prev.running.iter().filter(|r| r.path.starts_with("/chat/") && !t.running.contains(r)) {
                    notify(&app, "Zipper finished replying", &r.label);
                }
            }
            if last.as_ref() != Some(&t) {
                if let (Some(tray), Ok(menu)) = (app.tray_by_id("main"), tray_menu(&app, &t)) {
                    let mut title = Vec::new();
                    if !t.running.is_empty() {
                        title.push(format!("▶ {}", t.running.len()));
                    }
                    if t.inbox > 0 {
                        title.push(format!("✉ {}", t.inbox));
                    }
                    let _ = tray.set_menu(Some(menu));
                    let _ = tray.set_title((!title.is_empty()).then(|| title.join("  ")));
                }
                last = Some(t);
            }
        }
        sleep(Duration::from_secs(4)).await;
    }
}

/// SIGTERM so the server can stop its agent processes, then wait for it to go.
async fn stop(st: &Shared) {
    st.quitting.store(true, Ordering::SeqCst);
    let pid = st.pid.load(Ordering::SeqCst);
    if pid != 0 {
        let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
        for _ in 0..50 {
            if st.pid.load(Ordering::SeqCst) == 0 {
                break;
            }
            sleep(Duration::from_millis(100)).await;
        }
    }
    if let Some(pg) = st.pg.lock().await.as_mut() {
        let _ = pg.stop().await;
    }
}

/// Ctrl-C / `kill` skip RunEvent::Exit; route them through the normal exit path.
fn exit_on_signal(app: AppHandle) {
    use tokio::signal::unix::{signal, SignalKind};
    tauri::async_runtime::spawn(async move {
        let (mut int, mut term) = (signal(SignalKind::interrupt()).unwrap(), signal(SignalKind::terminate()).unwrap());
        tokio::select! { _ = int.recv() => {}, _ = term.recv() => {} }
        app.exit(0);
    });
}

pub fn run() {
    let st = Arc::new(Shared::default());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(st.clone())
        .invoke_handler(tauri::generate_handler![status, reset_builtin_db, capture_hide, capture_submit])
        .setup({
            let st = st.clone();
            move |app| {
                let cfg = app.config().app.windows[0].clone();
                let handle = app.handle().clone();
                tauri::WebviewWindowBuilder::from_config(app, &cfg)?
                    .on_navigation(stays_in_app)
                    .on_new_window(move |url, _| {
                        // No second windows: Zippy links open in place, the rest in the browser.
                        if stays_in_app(&url) {
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.navigate(url);
                            }
                        }
                        tauri::webview::NewWindowResponse::Deny
                    })
                    .build()?;
                // ⌘W: the native "Close Window" item would hide the window before the page ever sees the key.
                // Swap it for our own item so the page can claim it first (the terminals view closes the active shell).
                let menu = Menu::default(app.handle())?;
                for item in menu.items()? {
                    if let MenuItemKind::Submenu(sub) = item {
                        for (i, it) in sub.items()?.into_iter().enumerate() {
                            if let MenuItemKind::Predefined(p) = &it {
                                if p.text()?.starts_with("Close") {
                                    sub.remove_at(i)?;
                                    sub.insert(&MenuItem::with_id(app, "close", "Close Window", true, Some("CmdOrCtrl+W"))?, i)?;
                                }
                            }
                        }
                    }
                }
                app.set_menu(menu)?;
                app.on_menu_event(|app, e| {
                    if e.id() == "close" {
                        if let Some(w) = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false)) {
                            if w.label() == "main" {
                                let _ = w.emit("zippy:close", ());
                            } else {
                                let _ = w.hide();
                            }
                        }
                    }
                });
                {
                    use tauri_plugin_deep_link::DeepLinkExt;
                    let handle = app.handle().clone();
                    app.deep_link().on_open_url(move |e| e.urls().iter().for_each(|u| open_deep_link(&handle, u)));
                }
                // Template image: macOS tints it for light/dark menubars. Source: icons/tray.svg.
                TrayIconBuilder::with_id("main")
                    .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                    .icon_as_template(true)
                    .tooltip("Zippy")
                    .menu(&tray_menu(app.handle(), &Tray::default())?)
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app, e| match e.id().as_ref() {
                        "quit" => app.exit(0),
                        "open" => show(app, None),
                        "capture" => capture_open(app),
                        id => show(app, id.strip_prefix("nav:")),
                    })
                    .build(app)?;
                tauri::async_runtime::spawn(poll_tray(app.handle().clone()));
                exit_on_signal(app.handle().clone());
                tauri::async_runtime::spawn(supervise(app.handle().clone(), st));
                Ok(())
            }
        })
        // Closing the window keeps Zippy (and running Zippers) alive in the menubar.
        .on_window_event(|w, e| match e {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = w.hide();
            }
            // Spotlight-style: clicking elsewhere dismisses the capture window.
            WindowEvent::Focused(false) if w.label() == "capture" => {
                let _ = w.hide();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error building zippy");

    app.run(move |app, event| match event {
        RunEvent::Exit => tauri::async_runtime::block_on(stop(&st)),
        RunEvent::Reopen { .. } => show(app, None),
        _ => {}
    });
}
