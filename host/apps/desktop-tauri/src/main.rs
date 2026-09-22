mod input;
mod session;

use fs2::FileExt;
use std::collections::BTreeMap;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

use input::{InputCommand, InputRuntime, InputUpdate, Snapshot};
use session::{Session, SessionStore};
use tauri::{Manager, State, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::Mutex;
use url::Url;

struct Host {
    _instance_lock: std::fs::File,
    session: Mutex<SessionStore>,
    input: InputRuntime,
    exiting: AtomicBool,
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("This window cannot control native input.".into());
    }
    Ok(())
}

#[tauri::command]
async fn desktop_session(window: WebviewWindow, host: State<'_, Host>) -> Result<Session, String> {
    main_window(&window)?;
    Ok(host.session.lock().await.current.clone())
}

#[tauri::command]
async fn desktop_configure(
    window: WebviewWindow,
    host: State<'_, Host>,
    origin: Option<String>,
) -> Result<Session, String> {
    main_window(&window)?;
    let mut session = host.session.lock().await;
    let next = session.configure(origin)?;
    host.input.reset().await;
    Ok(next)
}

#[tauri::command]
async fn desktop_store(
    window: WebviewWindow,
    host: State<'_, Host>,
    generation: String,
    values: BTreeMap<String, String>,
) -> Result<(), String> {
    main_window(&window)?;
    host.session.lock().await.store(&generation, values)
}

#[tauri::command]
async fn input_attach(
    window: WebviewWindow,
    host: State<'_, Host>,
    generation: String,
    updates: tauri::ipc::Channel<InputUpdate>,
    practice: bool,
) -> Result<Snapshot, String> {
    main_window(&window)?;
    let session = host.session.lock().await;
    if generation != session.current.generation
        || (session.current.origin.is_none() && cfg!(feature = "custom-protocol"))
    {
        return Err("The configured space has changed.".into());
    }
    host.input.attach(updates, practice).await
}

#[tauri::command]
async fn input_acknowledge(
    window: WebviewWindow,
    host: State<'_, Host>,
    lease: String,
    revision: u64,
    ack: u64,
) -> Result<(), String> {
    main_window(&window)?;
    host.input.acknowledge(lease, revision, ack).await
}

#[tauri::command]
async fn input_command(
    window: WebviewWindow,
    host: State<'_, Host>,
    lease: String,
    command: InputCommand,
) -> Result<(), String> {
    main_window(&window)?;
    host.input.command(lease, command).await
}

fn open_external(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "Invalid browser address.")?;
    if value.len() > 8192
        || !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTP(S) browser addresses can be opened.".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new("xdg-open");
    let mut child = command
        .arg(url.as_str())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "Could not open the default browser.")?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
async fn desktop_open(window: WebviewWindow, url: String) -> Result<(), String> {
    main_window(&window)?;
    open_external(&url)
}

#[tauri::command]
async fn desktop_quit(window: WebviewWindow, host: State<'_, Host>) -> Result<(), String> {
    main_window(&window)?;
    host.exiting.store(true, Ordering::Release);
    host.input.shutdown().await;
    window.app_handle().exit(0);
    Ok(())
}

fn trusted_navigation(url: &Url) -> bool {
    matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")))
        || matches!(
            (url.scheme(), url.host_str()),
            ("http" | "https", Some("tauri.localhost"))
        )
        || (!cfg!(feature = "custom-protocol")
            && url.origin().ascii_serialization() == "http://localhost:5186")
}

fn main() {
    // WebKitGTK's Skia GPU workers can release GL resources concurrently with
    // NVIDIA's process-exit cleanup. Keep GPU painting on the main thread on
    // these systems, respecting an explicit WebKit override. Set the environment
    // before Tauri/GTK or the async runtime starts any threads.
    #[cfg(target_os = "linux")]
    if std::path::Path::new("/sys/module/nvidia").exists()
        && std::env::var_os("WEBKIT_SKIA_GPU_PAINTING_THREADS").is_none()
    {
        std::env::set_var("WEBKIT_SKIA_GPU_PAINTING_THREADS", "0");
    }

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            desktop_session,
            desktop_configure,
            desktop_store,
            desktop_open,
            desktop_quit,
            input_attach,
            input_acknowledge,
            input_command
        ])
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let instance_lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(directory.join("prototype.lock"))?;
            instance_lock
                .try_lock_exclusive()
                .map_err(|_| std::io::Error::other("GSV Tauri Prototype is already running."))?;
            let session = SessionStore::open(directory.clone()).map_err(std::io::Error::other)?;
            app.manage(Host {
                _instance_lock: instance_lock,
                session: Mutex::new(session),
                input: InputRuntime::start(),
                exiting: AtomicBool::new(false),
            });
            WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(directory.join("webview"))
                .on_navigation(trusted_navigation)
                .on_new_window(|url, _| {
                    let _ = open_external(url.as_str());
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("start GSV Tauri Prototype");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            let host = app.state::<Host>();
            if !host.exiting.swap(true, Ordering::AcqRel) {
                api.prevent_exit();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<Host>().input.shutdown().await;
                    app.exit(0);
                });
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
