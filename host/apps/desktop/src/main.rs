mod control;
mod downloads;
mod input;
mod machine;
mod session;
mod welcome;

use fs2::FileExt;
use std::collections::BTreeMap;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

use control::{ControlBridge, ControlEvent, ControlReply, DesktopHandler};
use desktop_protocol::{
    ClientOptions, DesktopControlClient, DesktopControlEndpoint, DesktopControlServer, RequestId,
    ServerOptions,
};
use input::{InputCommand, InputRuntime, InputUpdate, Snapshot};
use session::{Session, SessionStore};
use tauri::{Manager, State, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::Mutex;
use url::Url;

struct Host {
    _instance_lock: std::fs::File,
    session: Mutex<SessionStore>,
    welcome: Mutex<welcome::WelcomeStore>,
    input: InputRuntime,
    machine: machine::MachineRuntime,
    control: ControlBridge,
    control_shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    control_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    exiting: AtomicBool,
}

impl Host {
    async fn shutdown(&self) {
        self.control.reset();
        self.machine.shutdown().await;
        if let Some(stop) = self.control_shutdown.lock().await.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.control_task.lock().await.take() {
            let _ = task.await;
        }
        self.input.shutdown().await;
    }
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
    onboarding_token: Option<String>,
) -> Result<Session, String> {
    main_window(&window)?;
    let mut session = host.session.lock().await;
    let next = if onboarding_token.is_some() {
        session.configure_onboarding(origin, onboarding_token)?
    } else {
        session.configure(origin)?
    };
    host.machine.cancel();
    host.control.reset();
    host.input.reset().await;
    Ok(next)
}

#[tauri::command]
async fn desktop_welcome(
    window: WebviewWindow,
    host: State<'_, Host>,
) -> Result<welcome::Snapshot, String> {
    main_window(&window)?;
    Ok(host.welcome.lock().await.current.clone())
}

#[tauri::command]
async fn desktop_save_welcome(
    window: WebviewWindow,
    host: State<'_, Host>,
    revision: String,
    value: Option<welcome::Welcome>,
) -> Result<welcome::Snapshot, String> {
    main_window(&window)?;
    host.welcome.lock().await.save(&revision, value)
}

#[tauri::command]
async fn control_attach(
    window: WebviewWindow,
    host: State<'_, Host>,
    generation: String,
    updates: tauri::ipc::Channel<ControlEvent>,
) -> Result<String, String> {
    main_window(&window)?;
    let session = host.session.lock().await;
    if generation != session.current.generation {
        return Err("The configured space has changed.".into());
    }
    Ok(host.control.attach(updates))
}

#[tauri::command]
fn control_detach(
    window: WebviewWindow,
    host: State<'_, Host>,
    lease: String,
) -> Result<(), String> {
    main_window(&window)?;
    host.control.detach(&lease);
    Ok(())
}

#[tauri::command]
fn control_active(
    window: WebviewWindow,
    host: State<'_, Host>,
    lease: String,
    id: RequestId,
) -> Result<bool, String> {
    main_window(&window)?;
    Ok(host.control.active(&lease, id))
}

#[tauri::command]
fn control_reply(
    window: WebviewWindow,
    host: State<'_, Host>,
    lease: String,
    id: RequestId,
    reply: ControlReply,
) -> Result<(), String> {
    main_window(&window)?;
    host.control.reply(&lease, id, reply);
    Ok(())
}

#[tauri::command]
async fn desktop_store(
    window: WebviewWindow,
    host: State<'_, Host>,
    generation: String,
    values: BTreeMap<String, String>,
) -> Result<(), String> {
    main_window(&window)?;
    let mut session = host.session.lock().await;
    let previous = machine::session_username(&session.current);
    session.store(&generation, values)?;
    if machine::session_username(&session.current) != previous {
        host.machine.cancel();
    }
    Ok(())
}

#[tauri::command]
async fn machine_status(
    window: WebviewWindow,
    host: State<'_, Host>,
    generation: String,
    username: String,
) -> Result<machine::Snapshot, String> {
    main_window(&window)?;
    {
        let session = host.session.lock().await;
        machine::scope(&session.current, &generation, &username)?;
    }
    machine::inspect().await
}

#[tauri::command]
async fn machine_command(
    window: WebviewWindow,
    host: State<'_, Host>,
    generation: String,
    username: String,
    command: machine::MachineCommand,
) -> Result<machine::Snapshot, String> {
    main_window(&window)?;
    let (scope, operation) = {
        let session = host.session.lock().await;
        let scope = machine::scope(&session.current, &generation, &username)?;
        (scope, host.machine.prepare()?)
    };
    host.machine.run(scope, command, operation).await
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
    host.shutdown().await;
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
    if std::path::Path::new("/sys/module/nvidia").exists() {
        if std::env::var_os("WEBKIT_SKIA_GPU_PAINTING_THREADS").is_none() {
            std::env::set_var("WEBKIT_SKIA_GPU_PAINTING_THREADS", "0");
        }
        // The hardware-buffer transport can terminate GTK with Wayland error 71.
        // Shared-memory transport preserves the renderer while avoiding that path.
        if std::env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_none() {
            std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
        }
    }

    let endpoint =
        DesktopControlEndpoint::current_user().expect("resolve Desktop control endpoint");
    if tauri::async_runtime::block_on(
        DesktopControlClient::new(endpoint.clone(), ClientOptions::default()).activate(),
    )
    .is_ok()
    {
        return;
    }

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            desktop_session,
            desktop_configure,
            desktop_store,
            desktop_welcome,
            desktop_save_welcome,
            desktop_open,
            desktop_quit,
            machine_status,
            machine_command,
            input_attach,
            input_acknowledge,
            input_command,
            control_attach,
            control_detach,
            control_active,
            control_reply
        ])
        .setup(move |app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let instance_lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(directory.join("desktop.lock"))?;
            instance_lock
                .try_lock_exclusive()
                .map_err(|_| std::io::Error::other("GSV is already running."))?;
            // Import the explicitly supported upgrade once; never read CLI or driver credentials.
            if let Some(parent) = directory.parent() {
                SessionStore::import_previous_session(
                    &directory,
                    &parent.join("es.humansandmachines.gsv.tauri-prototype"),
                )
                .map_err(std::io::Error::other)?;
            }
            let session = SessionStore::open(directory.clone()).map_err(std::io::Error::other)?;
            let welcome =
                welcome::WelcomeStore::open(directory.clone()).map_err(std::io::Error::other)?;
            let control = ControlBridge::default();
            let server = tauri::async_runtime::block_on(async {
                DesktopControlServer::bind(
                    &endpoint,
                    DesktopHandler {
                        app: app.handle().clone(),
                        bridge: control.clone(),
                    },
                    ServerOptions::default(),
                )
            })?;
            let (control_shutdown, stopped) = tokio::sync::oneshot::channel();
            let control_task = tauri::async_runtime::spawn(async move {
                if server
                    .run_until(async {
                        let _ = stopped.await;
                    })
                    .await
                    .is_err()
                {
                    eprintln!("Desktop control server stopped unexpectedly.");
                }
            });
            app.manage(Host {
                _instance_lock: instance_lock,
                session: Mutex::new(session),
                welcome: Mutex::new(welcome),
                input: InputRuntime::start(),
                machine: machine::MachineRuntime::default(),
                control,
                control_shutdown: Mutex::new(Some(control_shutdown)),
                control_task: Mutex::new(Some(control_task)),
                exiting: AtomicBool::new(false),
            });
            let window = WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(directory.join("webview"))
                .on_navigation(trusted_navigation)
                .on_download(downloads::handle)
                .on_new_window(|url, _| {
                    let _ = open_external(url.as_str());
                    tauri::webview::NewWindowResponse::Deny
                });
            #[cfg(target_os = "linux")]
            let window = window.decorations(false);
            let window = window.build()?;
            #[cfg(target_os = "linux")]
            downloads::track_completion(&window)?;
            #[cfg(not(target_os = "linux"))]
            let _ = window;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("start GSV");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            let host = app.state::<Host>();
            if !host.exiting.swap(true, Ordering::AcqRel) {
                api.prevent_exit();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<Host>().shutdown().await;
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
