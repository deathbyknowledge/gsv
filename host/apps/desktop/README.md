# GSV Desktop

The installed `gsv-desktop` application hosts the shared Instrument UI. `gsv
desktop` launches or focuses it through same-user local IPC. The web frontend
owns the authenticated gateway connection; the native host owns local helpers,
session storage, window lifecycle, and CLI control. See the
[ownership contract](../../../../engineering/desktop.md).

## Build

Install Rust, Node/npm, and the platform build libraries. On Linux, WebKitGTK
4.1, GTK 3, ALSA, OpenSSL and camera development headers are required. The gesture
helper also requires CMake 3.22+, a C++20 compiler and network access for its first
checksum-pinned LiteRT/XNNPACK source build.

```bash
npm ci --ignore-scripts --workspace web --workspace packages/gsv --include-workspace-root=false
npm run gsv:build
npm run build:desktop --workspace web
cargo build --manifest-path host/Cargo.toml --locked --package desktop --package transcriber --package gestures
./host/target/debug/gsv-desktop
```

The packaged frontend is the default Cargo feature. For frontend development,
run Vite with `vite.desktop.config.ts` and build Desktop with
`--no-default-features`; it connects only to `http://localhost:5186`.

## Linux runtime

WebKitGTK 4.1 and GStreamer base/good/libav plugins must be installed. The audio
sink is needed by WebKit even though local dictation uses its own helper.

```bash
# Arch Linux
sudo pacman -S --needed webkit2gtk-4.1 gst-plugins-base gst-plugins-good gst-libav

# Ubuntu / Debian
sudo apt-get install libwebkit2gtk-4.1-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav
```

On NVIDIA Linux systems, Desktop defaults to WebKit shared-memory buffer
transport to avoid Wayland `Error 71` and failed GBM imports. An explicit
`WEBKIT_DMABUF_RENDERER_FORCE_SHM` value takes precedence. The app can stay on
Wayland; no desktop or display configuration is changed. If another driver
combination still needs XWayland, use this launch command:

```bash
GDK_BACKEND=x11 WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 ./host/target/debug/gsv-desktop
```

This selects XWayland and WebKit's shared-memory buffer transport for this
process only. It avoids the failing graphics-buffer path observed on the local
development machine; it is not a performance baseline or a system-wide setting.
See the [upstream Wry report](https://github.com/tauri-apps/wry/issues/1366) and
[WebKit's transport selection](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/gtk/AcceleratedBackingStore.cpp).

On Linux with the NVIDIA kernel module loaded, the host also defaults
`WEBKIT_SKIA_GPU_PAINTING_THREADS` to `0` before starting GTK or any runtime
threads. This avoids the GPU-worker cleanup path implicated in the local exit
crash. WebKit still paints with the GPU, but schedules that painting on its main
thread; compare responsiveness when qualifying other GPU/driver combinations. An
explicit value for this environment variable takes precedence. This is an
app-local mitigation for the observed WebKitGTK 2.52.6/NVIDIA 610.57.04 failure,
not a driver fix. See
[WebKit's painting modes](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebCore/platform/graphics/skia/SkiaPaintingEngine.cpp#L49-L54).

## Session and native input

Enter the HTTPS space address, then sign in. Credentials belong to the app's
private `space.gsv.desktop` data directory, separate from CLI and driver
credentials in `~/.gsv/config.toml`. Disconnect revokes the session and clears
the frontend's state. Quit flushes pending credential changes and shuts down
both helpers before exiting. A second launch activates the existing window.

The helpers live beside `gsv-desktop`. The speech model downloads with checksum
verification on first use; vision models are embedded. Neither camera nor
microphone starts at launch. Hands-free controls and their tutorial appear only
in Desktop. The web UI shares the same screens without native input controls.

After sign-in, Connect this computer enrolls the machine and starts its background
service without a terminal. Not now defers setup; the space menu's This computer
action reopens it. Desktop preserves the CLI login and any machine binding to
another space or account. An existing binding for this account starts automatically
when needed. The machine daemon owns its separate connection and service lifecycle;
quitting Desktop does not stop it.

## macOS

See [macOS packaging](../../packaging/macos/README.md). Releases contain
`GSV.app` ZIPs for Apple Silicon and Intel, including the CLI, daemon and helpers.
The developer builds use ad-hoc signing and do not require an Apple Developer ID.
