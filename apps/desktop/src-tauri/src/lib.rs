//! Shell around the Node sidecar (apps/server). Owns the DB choice: `config.json` `databaseUrl`
//! if set, otherwise a built-in Postgres. The server rewrites config.json and exits to switch DBs.
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};

use postgresql_embedded::{PostgreSQL, Settings};
use tauri::{AppHandle, Manager, RunEvent};
use tokio::{net::TcpStream, process::Command, sync::Mutex, time::sleep};

const PORT: u16 = 3311; // off the dev server's 3301
const PG_PORT: u16 = 54329;

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

// ponytail: dev layout only. Bundling Node + server deps is the next step; override with ZIPPY_ROOT.
fn repo_root() -> PathBuf {
    std::env::var("ZIPPY_ROOT").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
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
    let data = app.path().app_data_dir().expect("app data dir");
    let _ = std::fs::create_dir_all(&data);
    let cfg = data.join("config.json");
    let root = repo_root();
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
        let child = Command::new("node")
            .args(["--import", "tsx", "src/index.ts"])
            .current_dir(root.join("apps/server"))
            .env("PATH", &path)
            .env("PORT", PORT.to_string())
            .env("WEB_URL", format!("http://127.0.0.1:{PORT}"))
            .env("DATABASE_URL", url)
            .env("ZIPPY_DB_MODE", mode)
            .env("ZIPPY_CONFIG", &cfg)
            .env("ZIPPY_WEB_DIST", root.join("apps/web/dist"))
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                eprintln!("cannot start node: {e}");
                st.fails.fetch_add(1, Ordering::SeqCst);
                st.say(format!("Can't start Node: {e}. Is Node installed?"));
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
        .manage(st.clone())
        .invoke_handler(tauri::generate_handler![status, reset_builtin_db])
        .setup({
            let st = st.clone();
            move |app| {
                exit_on_signal(app.handle().clone());
                tauri::async_runtime::spawn(supervise(app.handle().clone(), st));
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error building zippy");

    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            tauri::async_runtime::block_on(stop(&st));
        }
    });
}
