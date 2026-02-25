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

use std::collections::HashMap;

use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget},
    window::{Window, WindowBuilder, WindowId},
};
use wry::{WebView, WebViewBuilder};

// ── Display Events ──

/// Events sent from the tokio async runtime to the main thread event loop.
#[derive(Debug)]
pub enum DisplayEvent {
    /// Open a new surface as a webview window.
    OpenSurface {
        surface_id: String,
        url: String,
        label: String,
    },
    /// Close an existing surface window.
    CloseSurface { surface_id: String },
    /// Update an existing surface (title).
    UpdateSurface {
        surface_id: String,
        label: Option<String>,
    },
    /// Shut down the display event loop.
    Shutdown,
}

// ── Display Handle (async-safe sender) ──

/// Cloneable handle for sending display events from any thread.
/// Wraps tao's EventLoopProxy which is Send + Sync.
#[derive(Clone)]
pub struct DisplayHandle {
    proxy: EventLoopProxy<DisplayEvent>,
}

impl DisplayHandle {
    pub fn open_surface(&self, surface_id: String, url: String, label: String) {
        let _ = self.proxy.send_event(DisplayEvent::OpenSurface {
            surface_id,
            url,
            label,
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

    pub fn shutdown(&self) {
        let _ = self.proxy.send_event(DisplayEvent::Shutdown);
    }
}

// ── Constructors ──

/// Create the display event loop and return a handle for async communication.
/// Call this on the main thread before spawning the tokio runtime.
pub fn create_display() -> (DisplayHandle, EventLoop<DisplayEvent>) {
    let event_loop = EventLoopBuilder::<DisplayEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    (DisplayHandle { proxy }, event_loop)
}

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
    _webview: WebView,
}

/// Run the display event loop. **Blocks the calling thread forever.**
/// Must be called on the main thread (macOS Cocoa requirement).
pub fn run_display_loop(event_loop: EventLoop<DisplayEvent>) -> ! {
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
) {
    match event {
        DisplayEvent::OpenSurface {
            surface_id,
            url,
            label,
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

            let webview = match WebViewBuilder::new()
                .with_url(&url)
                .with_user_agent(ua)
                .with_autoplay(true)
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

            eprintln!("[display] Opened surface {} -> {}", surface_id, url);
            let window_id = window.id();
            window_to_surface.insert(window_id, surface_id.clone());
            surfaces.insert(
                surface_id,
                SurfaceWindow {
                    window,
                    _webview: webview,
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
        DisplayEvent::Shutdown => {
            eprintln!("[display] Shutdown requested");
            *control_flow = ControlFlow::Exit;
        }
    }
}
