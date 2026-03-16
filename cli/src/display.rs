//! Display module — native webview windows for surface rendering.
//!
//! When a node runs with `--display`, this module creates a tao event loop
//! on the main thread and manages wry webview windows for each surface
//! that targets this node.
//!
//! Architecture:
//!   Main thread:  tao EventLoop (blocks forever, manages windows)
//!   Background:   tokio runtime (WebSocket connection, tool execution)
//!   Communication: EventLoopProxy<DisplayEvent> (Send, thread-safe)
//!                  + mpsc channel for eval results (main → tokio)

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;

use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget},
    window::{Window, WindowBuilder, WindowId},
};
use wry::{WebContext, WebView, WebViewBuilder};

// ── Display Events ──

/// Events sent from the tokio async runtime to the main thread event loop.
#[derive(Debug)]
pub enum DisplayEvent {
    /// Open a new surface as a webview window.
    OpenSurface {
        surface_id: String,
        url: String,
        label: String,
        /// Browser profile ID (derived from URL origin). When set,
        /// wry uses a persistent data directory for this profile.
        profile_id: Option<String>,
    },
    /// Close an existing surface window.
    CloseSurface { surface_id: String },
    /// Update an existing surface (title).
    UpdateSurface {
        surface_id: String,
        label: Option<String>,
    },
    /// Execute JavaScript in a webview surface and return the result via IPC.
    EvalScript {
        surface_id: String,
        eval_id: String,
        script: String,
    },
    /// Shut down the display event loop.
    Shutdown,
}

// ── Eval Result (main thread → tokio) ──

/// Result of a JavaScript eval, sent from the main thread IPC handler
/// back to the tokio runtime for forwarding to the gateway.
#[derive(Debug, Clone)]
pub struct EvalResult {
    pub eval_id: String,
    pub surface_id: String,
    pub ok: bool,
    pub result: Option<String>,
    pub error: Option<String>,
}

// ── Display Handle (async-safe sender) ──

/// Cloneable handle for sending display events from any thread.
/// Wraps tao's EventLoopProxy which is Send + Sync.
#[derive(Clone)]
pub struct DisplayHandle {
    proxy: EventLoopProxy<DisplayEvent>,
    /// Base directory for browser profile storage.
    /// Profiles are stored in `{profile_dir}/{profile_id}/`.
    pub profile_dir: PathBuf,
}

impl DisplayHandle {
    pub fn open_surface(
        &self,
        surface_id: String,
        url: String,
        label: String,
        profile_id: Option<String>,
    ) {
        let _ = self.proxy.send_event(DisplayEvent::OpenSurface {
            surface_id,
            url,
            label,
            profile_id,
        });
    }

    pub fn close_surface(&self, surface_id: String) {
        let _ = self
            .proxy
            .send_event(DisplayEvent::CloseSurface { surface_id });
    }

    pub fn update_surface(&self, surface_id: String, label: Option<String>) {
        let _ = self
            .proxy
            .send_event(DisplayEvent::UpdateSurface { surface_id, label });
    }

    pub fn eval_script(&self, surface_id: String, eval_id: String, script: String) {
        let _ = self.proxy.send_event(DisplayEvent::EvalScript {
            surface_id,
            eval_id,
            script,
        });
    }

    pub fn shutdown(&self) {
        let _ = self.proxy.send_event(DisplayEvent::Shutdown);
    }
}

// ── Constructors ──

/// Create the display event loop and return a handle for async communication,
/// plus a receiver for eval results flowing from the main thread back to tokio.
/// Call this on the main thread before spawning the tokio runtime.
pub fn create_display(
    profile_dir: PathBuf,
) -> (
    DisplayHandle,
    EventLoop<DisplayEvent>,
    mpsc::Receiver<EvalResult>,
) {
    let event_loop = EventLoopBuilder::<DisplayEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let (eval_tx, eval_rx) = mpsc::channel();
    // Store the eval sender in a thread-local so IPC handlers can access it.
    // We pass it into run_display_loop instead.
    EVAL_RESULT_SENDER.lock().unwrap().replace(eval_tx);
    (DisplayHandle { proxy, profile_dir }, event_loop, eval_rx)
}

/// Global eval result sender. Set once by `create_display`, used by IPC handlers
/// in webviews (which run on the main thread alongside the event loop).
/// Using a Mutex<Option<>> because wry IPC closures need 'static + Fn.
static EVAL_RESULT_SENDER: std::sync::Mutex<Option<mpsc::Sender<EvalResult>>> =
    std::sync::Mutex::new(None);

// ── URL Resolution ──

/// Convert a WebSocket gateway URL to an HTTP URL for loading the web UI.
pub fn gateway_http_url(ws_url: &str) -> String {
    ws_url
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches("/ws")
        .to_string()
}

/// Normalize a URL to its embeddable form for known services.
/// Native webviews don't have X-Frame-Options restrictions, but embed URLs
/// give us autoplay and a cleaner player UI.
pub fn to_embed_url(raw: &str) -> String {
    // Parse or return as-is
    let Ok(url) = url::Url::parse(raw) else {
        return raw.to_string();
    };
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .trim_start_matches("m.");

    // YouTube
    if host == "youtube.com" {
        // watch?v=ID
        if let Some(vid) = url
            .query_pairs()
            .find(|(k, _)| k == "v")
            .map(|(_, v)| v.to_string())
        {
            return format!("https://www.youtube.com/embed/{}?autoplay=1", vid);
        }
        // /shorts/ID
        if let Some(rest) = url.path().strip_prefix("/shorts/") {
            let id = rest.split('/').next().unwrap_or(rest);
            if !id.is_empty() {
                return format!("https://www.youtube.com/embed/{}?autoplay=1", id);
            }
        }
        // Already /embed/ — add autoplay if missing
        if url.path().starts_with("/embed/") {
            if url.query().map_or(true, |q| !q.contains("autoplay")) {
                let sep = if url.query().is_some() { "&" } else { "?" };
                return format!("{}{}autoplay=1", raw, sep);
            }
            return raw.to_string();
        }
    }
    if host == "youtu.be" {
        let id = url
            .path()
            .trim_start_matches('/')
            .split('/')
            .next()
            .unwrap_or("");
        if !id.is_empty() {
            return format!("https://www.youtube.com/embed/{}?autoplay=1", id);
        }
    }

    // Vimeo
    if host == "vimeo.com" {
        if let Some(id) = url.path().trim_start_matches('/').split('/').next() {
            if id.chars().all(|c| c.is_ascii_digit()) && !id.is_empty() {
                return format!("https://player.vimeo.com/video/{}?autoplay=1", id);
            }
        }
    }
    if host == "player.vimeo.com" {
        if url.query().map_or(true, |q| !q.contains("autoplay")) {
            let sep = if url.query().is_some() { "&" } else { "?" };
            return format!("{}{}autoplay=1", raw, sep);
        }
        return raw.to_string();
    }

    // Spotify
    if host == "open.spotify.com" && !url.path().starts_with("/embed/") {
        return format!("https://open.spotify.com/embed{}", url.path());
    }

    // Figma
    if host == "figma.com"
        && (url.path().starts_with("/file/") || url.path().starts_with("/design/"))
    {
        return format!(
            "https://www.figma.com/embed?embed_host=gsv&url={}",
            urlencoding::encode(raw)
        );
    }

    // Loom
    if host == "loom.com" {
        if let Some(rest) = url.path().strip_prefix("/share/") {
            let id = rest
                .split('/')
                .next()
                .unwrap_or(rest)
                .split('?')
                .next()
                .unwrap_or(rest);
            if !id.is_empty() {
                return format!("https://www.loom.com/embed/{}?autoplay=1", id);
            }
        }
    }

    raw.to_string()
}

/// Resolve the URL to load in a webview for a given surface.
/// Unlike the web UI (which needs embed URLs for iframe X-Frame-Options),
/// native wry webviews are full browser contexts that can load any URL directly.
pub fn resolve_surface_url(ws_url: &str, kind: &str, content_ref: &str) -> String {
    match kind {
        "webview" | "media" => content_ref.to_string(),
        "app" => {
            let base = gateway_http_url(ws_url);
            format!("{}/?shell=os&tab={}", base, content_ref)
        }
        _ => content_ref.to_string(),
    }
}

// ── Event Loop ──

struct SurfaceWindow {
    window: Window,
    webview: WebView,
    /// Browser profile context. Must outlive the WebView.
    /// Drop order: webview drops first, then _web_context.
    _web_context: Option<WebContext>,
}

/// Run the display event loop. **Blocks the calling thread forever.**
/// Must be called on the main thread (macOS Cocoa requirement).
pub fn run_display_loop(event_loop: EventLoop<DisplayEvent>, profile_dir: PathBuf) -> ! {
    let mut surfaces: HashMap<String, SurfaceWindow> = HashMap::new();
    let mut window_to_surface: HashMap<WindowId, String> = HashMap::new();

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::UserEvent(display_event) => {
                handle_display_event(
                    display_event,
                    target,
                    &mut surfaces,
                    &mut window_to_surface,
                    control_flow,
                    &profile_dir,
                );
            }
            Event::WindowEvent {
                window_id,
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if let Some(surface_id) = window_to_surface.remove(&window_id) {
                    surfaces.remove(&surface_id);
                    eprintln!("[display] Window closed by user: {}", surface_id);
                }
            }
            _ => {}
        }
    })
}

fn handle_display_event(
    event: DisplayEvent,
    target: &EventLoopWindowTarget<DisplayEvent>,
    surfaces: &mut HashMap<String, SurfaceWindow>,
    window_to_surface: &mut HashMap<WindowId, String>,
    control_flow: &mut ControlFlow,
    profile_dir: &PathBuf,
) {
    match event {
        DisplayEvent::OpenSurface {
            surface_id,
            url,
            label,
            profile_id,
        } => {
            // Close existing surface with the same ID (replace)
            if let Some(old) = surfaces.remove(&surface_id) {
                window_to_surface.remove(&old.window.id());
            }

            let window = match WindowBuilder::new()
                .with_title(&label)
                .with_inner_size(LogicalSize::new(1024.0, 768.0))
                .build(target)
            {
                Ok(w) => w,
                Err(e) => {
                    eprintln!(
                        "[display] Failed to create window for surface {}: {}",
                        surface_id, e
                    );
                    return;
                }
            };

            // Native webviews are full browser contexts — no iframe restrictions.
            // Load the original URL directly (no embed conversion needed).
            let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

            // Persistent browser profile: assign a data directory so cookies,
            // localStorage, and IndexedDB survive across window close/reopen.
            // WebContext must outlive the WebView, so we keep it in an Option
            // and store it alongside the window.
            let mut web_context_storage: Option<WebContext> = None;
            if let Some(ref pid) = profile_id {
                let data_dir = profile_dir.join(pid);
                if let Err(e) = std::fs::create_dir_all(&data_dir) {
                    eprintln!(
                        "[display] Failed to create profile dir {:?}: {}",
                        data_dir, e
                    );
                } else {
                    eprintln!("[display] Using browser profile: {} -> {:?}", pid, data_dir);
                    web_context_storage = Some(WebContext::new(Some(data_dir)));
                }
            }

            let builder = if let Some(ref mut ctx) = web_context_storage {
                WebViewBuilder::new_with_web_context(ctx)
            } else {
                WebViewBuilder::new()
            };

            // Clone surface_id for the IPC handler closure
            let sid_for_ipc = surface_id.clone();

            let webview = match builder
                .with_url(&url)
                .with_user_agent(ua)
                .with_autoplay(true)
                .with_ipc_handler(move |msg: wry::http::Request<String>| {
                    // IPC handler: receives JSON messages from JavaScript in the webview.
                    // Used for returning eval script results.
                    let body = msg.body();
                    handle_ipc_message(&sid_for_ipc, body);
                })
                .build(&window)
            {
                Ok(wv) => wv,
                Err(e) => {
                    eprintln!(
                        "[display] Failed to create webview for surface {}: {}",
                        surface_id, e
                    );
                    return;
                }
            };

            eprintln!(
                "[display] Opened surface {} -> {}{}",
                surface_id,
                url,
                profile_id
                    .as_deref()
                    .map(|p| format!(" (profile: {})", p))
                    .unwrap_or_default()
            );
            let window_id = window.id();
            window_to_surface.insert(window_id, surface_id.clone());
            surfaces.insert(
                surface_id,
                SurfaceWindow {
                    window,
                    webview,
                    _web_context: web_context_storage,
                },
            );
        }
        DisplayEvent::CloseSurface { surface_id } => {
            if let Some(sw) = surfaces.remove(&surface_id) {
                window_to_surface.remove(&sw.window.id());
                eprintln!("[display] Closed surface {}", surface_id);
            }
        }
        DisplayEvent::UpdateSurface { surface_id, label } => {
            if let Some(sw) = surfaces.get(&surface_id) {
                if let Some(label) = label {
                    sw.window.set_title(&label);
                    eprintln!("[display] Updated surface {} title: {}", surface_id, label);
                }
            }
        }
        DisplayEvent::EvalScript {
            surface_id,
            eval_id,
            script,
        } => {
            if let Some(sw) = surfaces.get(&surface_id) {
                // Two-call eval strategy — no eval() used, CSP/Trusted Types safe.
                //
                // wry's evaluate_script() bypasses page CSP (engine-level injection),
                // but we can't use JS eval() because sites like YouTube enforce Trusted Types.
                //
                // Call 1 (expression form): wraps the script as `return (SCRIPT)`.
                //   - Captures expression return values (document.title, Array.from(...), etc.)
                //   - If the script has semicolons, this fails to parse SILENTLY (no code runs).
                //
                // Call 2 (statement form): wraps the script as-is in a function body.
                //   - Always parseable for valid JS. Handles multi-statement scripts.
                //   - Doesn't capture the last expression's value (returns undefined).
                //
                // A global guard prevents duplicate IPC responses. Call 1 runs first
                // (JS is single-threaded); if it succeeds, Call 2 is a no-op.
                let eval_id_json =
                    serde_json::to_string(&eval_id).unwrap_or_else(|_| format!("\"{}\"", eval_id));

                // Call 1: expression form — captures return value
                let expr_call = format!(
                    r#"(async () => {{
    if (window.__gsv_ed && window.__gsv_ed[{eid}]) return;
    try {{
        const __r = await (async () => {{ return ({script}); }})();
        if (window.__gsv_ed && window.__gsv_ed[{eid}]) return;
        window.__gsv_ed = window.__gsv_ed || {{}};
        window.__gsv_ed[{eid}] = true;
        window.ipc.postMessage(JSON.stringify({{
            type: "eval_result", evalId: {eid}, ok: true, result: __r
        }}));
    }} catch (_) {{}}
}})()"#,
                    script = script,
                    eid = eval_id_json,
                );

                // Call 2: statement form — always parseable, always responds
                let stmt_call = format!(
                    r#"(async () => {{
    if (window.__gsv_ed && window.__gsv_ed[{eid}]) return;
    try {{
        await (async () => {{ {script} }})();
        if (window.__gsv_ed && window.__gsv_ed[{eid}]) return;
        window.__gsv_ed = window.__gsv_ed || {{}};
        window.__gsv_ed[{eid}] = true;
        window.ipc.postMessage(JSON.stringify({{
            type: "eval_result", evalId: {eid}, ok: true
        }}));
    }} catch (__e) {{
        if (window.__gsv_ed && window.__gsv_ed[{eid}]) return;
        window.__gsv_ed = window.__gsv_ed || {{}};
        window.__gsv_ed[{eid}] = true;
        window.ipc.postMessage(JSON.stringify({{
            type: "eval_result", evalId: {eid}, ok: false, error: String(__e)
        }}));
    }}
}})()"#,
                    script = script,
                    eid = eval_id_json,
                );

                let mut dispatched = false;
                if let Err(e) = sw.webview.evaluate_script(&expr_call) {
                    eprintln!(
                        "[display] Eval expr call failed for surface {}: {}",
                        surface_id, e
                    );
                } else {
                    dispatched = true;
                }
                if let Err(e) = sw.webview.evaluate_script(&stmt_call) {
                    eprintln!(
                        "[display] Eval stmt call failed for surface {}: {}",
                        surface_id, e
                    );
                } else {
                    dispatched = true;
                }

                if dispatched {
                    eprintln!(
                        "[display] Eval dispatched: {} in surface {}",
                        eval_id, surface_id
                    );
                } else {
                    // Both calls failed at the engine level
                    if let Ok(guard) = EVAL_RESULT_SENDER.lock() {
                        if let Some(ref tx) = *guard {
                            let _ = tx.send(EvalResult {
                                eval_id,
                                surface_id,
                                ok: false,
                                result: None,
                                error: Some("Failed to dispatch eval to webview".to_string()),
                            });
                        }
                    }
                }
            } else {
                eprintln!("[display] Eval failed: surface {} not found", surface_id);
                // Send error result back
                if let Ok(guard) = EVAL_RESULT_SENDER.lock() {
                    if let Some(ref tx) = *guard {
                        let _ = tx.send(EvalResult {
                            eval_id,
                            surface_id,
                            ok: false,
                            result: None,
                            error: Some("Surface not found on this display node".to_string()),
                        });
                    }
                }
            }
        }
        DisplayEvent::Shutdown => {
            eprintln!("[display] Shutdown requested");
            *control_flow = ControlFlow::Exit;
        }
    }
}

/// Handle an IPC message from a webview. Called on the main thread.
/// Parses eval result JSON and sends it through the eval result channel.
fn handle_ipc_message(surface_id: &str, body: &str) {
    // Parse the JSON message
    let msg: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[display] IPC parse error from surface {}: {} (body: {})",
                surface_id,
                e,
                &body[..body.len().min(200)]
            );
            return;
        }
    };

    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match msg_type {
        "eval_result" => {
            let eval_id = msg
                .get("evalId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let ok = msg.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let result = msg.get("result").map(|v| v.to_string());
            let error = msg
                .get("error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if eval_id.is_empty() {
                eprintln!(
                    "[display] IPC eval_result missing evalId from surface {}",
                    surface_id
                );
                return;
            }

            eprintln!(
                "[display] IPC eval result: {} ok={} surface={}",
                eval_id, ok, surface_id
            );

            if let Ok(guard) = EVAL_RESULT_SENDER.lock() {
                if let Some(ref tx) = *guard {
                    let _ = tx.send(EvalResult {
                        eval_id,
                        surface_id: surface_id.to_string(),
                        ok,
                        result,
                        error,
                    });
                }
            }
        }
        _ => {
            eprintln!(
                "[display] Unknown IPC message type '{}' from surface {}",
                msg_type, surface_id
            );
        }
    }
}
