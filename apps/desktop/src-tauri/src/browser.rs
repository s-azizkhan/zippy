//! Browser tabs: child webviews inside the main window, driven by the server over a long-poll bridge.
//! The server owns the tab list, approvals and agent tools; this file only runs webviews.
//! Pages in tabs get no Tauri IPC (no capability matches remote origins), so a site can't reach our commands.
use std::{
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{
    utils::config::BackgroundThrottlingPolicy,
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};
use tokio::time::sleep;

use super::{notify, Shared, PORT};

const TAB: &str = "tab-";
// One store for every tab: signing in once covers all tabs and survives restarts. macOS 14+.
const STORE: [u8; 16] = *b"zippy-browser-01";
// WKWebView's default UA has no "Safari/…" token, and Google/Slack treat it as an unsupported browser.
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
// WKWebView has no Web Notifications: fake a granted one and queue them; `drain_notes` shows them natively.
const NOTIFY_SHIM: &str = r#"(() => {
  const q = (window.__zippyNotes = []);
  class Notification extends EventTarget {
    static permission = "granted";
    static requestPermission(cb) { cb && cb("granted"); return Promise.resolve("granted"); }
    constructor(title, o = {}) {
      super();
      this.title = String(title); this.body = String(o.body || "");
      this.onclick = this.onclose = this.onerror = this.onshow = null;
      if (q.length < 20) q.push({ title: this.title.slice(0, 200), body: this.body.slice(0, 500) });
    }
    close() {}
  }
  window.Notification = Notification;
})();"#;

#[derive(Default)]
pub struct Browser {
    bounds: Mutex<Option<(f64, f64, f64, f64)>>,
    popups: std::sync::atomic::AtomicU32,
}

#[derive(serde::Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Cmd {
    Open { tab: String, url: String },
    Close { tab: String },
    Navigate { tab: String, url: String },
    Show { tab: Option<String> },
    Bounds { x: f64, y: f64, w: f64, h: f64 },
    Eval { tab: String, js: String },
}

#[derive(serde::Deserialize)]
struct Job {
    id: String,
    #[serde(flatten)]
    cmd: Cmd,
}

fn bridge_url(path: &str) -> String {
    format!("http://127.0.0.1:{PORT}/api/browser/bridge{path}")
}

/// Tab → server: title, url, loading, links that want a new tab.
fn post_event(secret: &str, body: Value) {
    let secret = secret.to_owned();
    tauri::async_runtime::spawn(async move {
        let _ = reqwest::Client::new().post(bridge_url("/event")).header("x-zippy-bridge", secret).json(&body).send().await;
    });
}

fn tabs(app: &AppHandle) -> impl Iterator<Item = (String, tauri::Webview)> {
    app.webviews().into_iter().filter(|(l, _)| l.starts_with(TAB))
}

fn open_tab(app: &AppHandle, st: &Shared, tab: &str, url: Url) -> Result<(), String> {
    let win = app.get_window("main").ok_or("main window missing")?;
    let (x, y, w, h) = st.browser.bounds.lock().unwrap().unwrap_or((0.0, 0.0, 1280.0, 800.0));
    let id = tab.to_owned();
    let (s1, s2, s3) = (st.secret.clone(), st.secret.clone(), st.secret.clone());
    let (id1, id2, id3) = (id.clone(), id.clone(), id.clone());
    let handle = app.clone();
    let builder = WebviewBuilder::new(format!("{TAB}{tab}"), WebviewUrl::External(url))
        .data_store_identifier(STORE)
        .user_agent(UA)
        .initialization_script(NOTIFY_SHIM)
        // Hidden tabs keep their sockets and timers, so Slack/Gmail still notify.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .on_navigation(|url| match url.scheme() {
            "http" | "https" | "about" | "blob" | "data" => true,
            // Only mailto: leaves the tab; pages must not launch arbitrary URL handlers.
            "mailto" => {
                let _ = std::process::Command::new("open").arg(url.as_str()).spawn();
                false
            }
            _ => false,
        })
        .on_page_load(move |_, p| post_event(&s1, json!({ "tab": id1, "url": p.url().as_str(), "loading": p.event() == PageLoadEvent::Started })))
        .on_document_title_changed(move |_, title| post_event(&s2, json!({ "tab": id2, "title": title })))
        .on_new_window(move |url, features| {
            // window.open with a size is a sign-in popup that needs its opener; plain target=_blank links become tabs.
            if features.size().is_some() {
                let st = handle.state::<Arc<Shared>>();
                let label = format!("popup-{}", st.browser.popups.fetch_add(1, Ordering::SeqCst));
                if let Ok(window) = tauri::WebviewWindowBuilder::new(&handle, label, WebviewUrl::External(url)).window_features(features).user_agent(UA).title("Sign in").build() {
                    return NewWindowResponse::Create { window };
                }
            } else {
                post_event(&s3, json!({ "tab": id3, "newTab": url.as_str() }));
            }
            NewWindowResponse::Deny
        });
    let wv = win.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    wv.hide().map_err(|e| e.to_string())
}

/// Runs one command. Eval returns whatever string the script returned (the server wraps every script in JSON.stringify).
async fn run(app: &AppHandle, st: &Shared, cmd: Cmd) -> Result<Value, String> {
    let get = |tab: &str| app.get_webview(&format!("{TAB}{tab}")).ok_or_else(|| format!("tab {tab} is not open"));
    let parse = |u: &str| u.parse::<Url>().map_err(|e| e.to_string());
    match cmd {
        Cmd::Open { tab, url } => {
            // Idempotent: after a server restart the server re-opens every tab it remembers.
            if get(&tab).is_err() {
                open_tab(app, st, &tab, parse(&url)?)?;
            }
        }
        Cmd::Close { tab } => get(&tab)?.close().map_err(|e| e.to_string())?,
        Cmd::Navigate { tab, url } => get(&tab)?.navigate(parse(&url)?).map_err(|e| e.to_string())?,
        Cmd::Show { tab } => {
            let want = tab.map(|t| format!("{TAB}{t}"));
            for (label, wv) in tabs(app) {
                if Some(&label) == want.as_ref() {
                    wv.show().map_err(|e| e.to_string())?;
                } else {
                    wv.hide().map_err(|e| e.to_string())?;
                }
            }
        }
        Cmd::Bounds { x, y, w, h } => {
            *st.browser.bounds.lock().unwrap() = Some((x, y, w, h));
            for (_, wv) in tabs(app) {
                let _ = wv.set_position(LogicalPosition::new(x, y));
                let _ = wv.set_size(LogicalSize::new(w, h));
            }
        }
        Cmd::Eval { tab, js } => {
            let (tx, rx) = tokio::sync::oneshot::channel::<String>();
            let tx = Mutex::new(Some(tx));
            get(&tab)?
                .eval_with_callback(js, move |s| {
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(s);
                    }
                })
                .map_err(|e| e.to_string())?;
            let s = tokio::time::timeout(Duration::from_secs(15), rx).await.map_err(|_| "script timed out")?.map_err(|_| "tab closed")?;
            // "" = the script threw or returned nothing (a navigation can also cut it off).
            return Ok(serde_json::from_str(&s).unwrap_or(Value::Null));
        }
    }
    Ok(Value::Null)
}

/// Long-polls the server for commands and posts each result back. Survives server restarts.
pub async fn bridge(app: AppHandle, st: Arc<Shared>) {
    let http = reqwest::Client::new();
    loop {
        let jobs = match http.get(bridge_url("")).header("x-zippy-bridge", &st.secret).timeout(Duration::from_secs(40)).send().await {
            Ok(r) if r.status().is_success() => r.json::<Vec<Job>>().await.unwrap_or_default(),
            _ => {
                sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        for Job { id, cmd } in jobs {
            let (app, st, http) = (app.clone(), st.clone(), http.clone());
            tauri::async_runtime::spawn(async move {
                let body = match run(&app, &st, cmd).await {
                    Ok(value) => json!({ "id": id, "ok": true, "value": value }),
                    Err(error) => json!({ "id": id, "ok": false, "error": error }),
                };
                let _ = http.post(bridge_url("")).header("x-zippy-bridge", &st.secret).json(&body).send().await;
            });
        }
    }
}

#[derive(serde::Deserialize)]
struct Note {
    title: String,
    body: String,
}

/// Shows notifications the tabs queued through NOTIFY_SHIM.
pub async fn drain_notes(app: AppHandle) {
    loop {
        sleep(Duration::from_secs(2)).await;
        for (_, wv) in tabs(&app) {
            let host = wv.url().ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_owned())).unwrap_or_default();
            let app = app.clone();
            let _ = wv.eval_with_callback("JSON.stringify((window.__zippyNotes || []).splice(0, 3))", move |s| {
                let notes: Vec<Note> = serde_json::from_str::<String>(&s).ok().and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
                for n in notes {
                    notify(&app, &n.title, &format!("{}{}{host}", n.body, if n.body.is_empty() { "" } else { " · " }));
                }
            });
        }
    }
}
