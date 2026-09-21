# GSV Tauri Prototype

An isolated executable hosting the real Instrument/Zen frontend. It reuses the
production native helper supervisors through `desktop-native`. Production GPUI
Desktop, its credentials, daemon, CLI endpoint and installer remain separate.
The ownership record is [here](../../../../engineering/desktop-tauri-prototype.md).

## Build and open on Linux

From the repository root, with Rust, Node/npm and the
[Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux):

Install WebKit's media runtime as well as its development libraries. The shared
frontend renders audio/video attachments, and WebKitGTK needs GStreamer plugins
even though native voice capture runs in `gsv-transcribe`:

```bash
# Arch Linux
sudo pacman -S --needed gst-plugins-base gst-plugins-good gst-libav

# Ubuntu / Debian
sudo apt-get install gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav
```

`autoaudiosink` comes from [GStreamer Good Plug-ins](https://gstreamer.freedesktop.org/documentation/autodetect/autoaudiosink.html).
If it is missing, WebKitGTK 2.52.6 can abort its page process during media
initialization, leaving the native window unresponsive. This was observed on
the prototype machine; successfully compiling WebKit bindings does not establish
that these runtime plugins are installed.

Build and launch:

```bash
npm ci --ignore-scripts --workspace web --workspace packages/gsv --include-workspace-root=false
npm run gsv:build
npm run build --workspace web -- --config vite.desktop.config.ts
cargo build --manifest-path host/Cargo.toml --locked --package desktop-tauri --features custom-protocol --package transcriber --package gestures
./host/target/debug/gsv-desktop-tauri
```

If startup exits with a Wayland `Error 71` or opens a blank window with
`Failed to create GBM buffer`, use this launch command from the repository root:

```bash
GDK_BACKEND=x11 WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 ./host/target/debug/gsv-desktop-tauri
```

This selects XWayland and WebKit's shared-memory buffer transport for this
process only. It avoids the failing graphics-buffer path observed on the local
prototype machine; it is not a performance baseline or a system-wide setting.
See the [upstream Wry report](https://github.com/tauri-apps/wry/issues/1366) and
[WebKit's transport selection](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/gtk/AcceleratedBackingStore.cpp).

The helpers must be beside the executable. The speech helper may download its
checksum-pinned model on the first explicit Voice request; the vision models are
embedded in `gsv-vision`. Nothing starts the camera or microphone at app launch.
Enable gestures or start voice explicitly. Existing `GSV_GESTURES=0` and
`GSV_GESTURE_DEBUG=1` switches remain supported by the shared supervisor.

Enter the HTTPS origin of the space, then sign in through the ordinary shared
login form. HTTP is supported for localhost only. No production URL or credential
is built into the app. Native session data lives under the platform application
data directory for `es.humansandmachines.gsv.tauri-prototype`; it does not read
`~/.gsv/config.toml`. Only one prototype instance can own this directory.

Close minimizes the window on Linux and hides the application on macOS. Use the
visible Quit action to end the prototype and its helpers. The ordinary installed
Desktop can be opened as usual. `gsv desktop` continues to address that installed
application: this prototype does not claim its local CLI control endpoint.

## Development mock

In one terminal from the repository root:

```bash
npm run dev --workspace web -- --config vite.desktop.config.ts
```

In another:

```bash
cargo run --manifest-path host/Cargo.toml --package desktop-tauri
```

The development server uses port 5186 and refuses to take an occupied port. Choose
“open the development mock” on the space-address screen. `/run`, `/stream`,
`/reply` and `/approve` use the existing in-memory gateway. Mock selection and
credentials are never written to the native session file. The production build
excludes the mock. The real helpers are still real in development mode.

## Human acceptance pass

1. Connect the production space yourself. Check Zen, theme, receipts, approvals,
   streaming, attachment send and optimistic message acknowledgement.
2. Open Voice beside Attach, then start listening. Check preparation, partial text, finish, cancel, device selection,
   and acknowledged mute. Type before/after the dictated range. Editing inside
   dictated text stops capture and preserves the correction; restart Voice to
   continue. Enter while listening uses ordinary conversation sending, preserves
   files and keeps the microphone on. Opening controls alone must not capture
   microphone audio; closing them must not silently stop active dictation.
3. Open Gestures and enable the camera: it starts disarmed. Deliberately arm, then check the existing
   1–5 vocabulary (start/finish, send, delete, clear, mute), fist reset, scroll
   chord and tracking loss. The quiet gesture control shows camera/armed state,
   a recognized hold's progress and accepted commands; its panel contains the
   hand guide. Clear/delete affect only unsent dictated text. The panel closes
   with Escape or an outside click, without resizing the conversation. All
   feedback stays outside the editable draft.
4. Try unfocused use and minimization. If the webview stops responding for three
   seconds, native input stops and disarms. Reconnect native input and explicitly
   restart it. No old action should arrive in a later draft. Repeat after sleep,
   reload, Process selection change and logout.
5. Disconnect the space, then select another destination. Its username may also
   be `root`; it must show fresh sign-in with no old history, draft, uploads,
   pending sends or terminal recovery. The disconnect action warns about unsent
   work and tears down the whole frontend.
6. Quit and reopen. Camera/voice must be off and gestures disarmed. The independent
   daemon and installed Desktop should remain available.
7. Cycle `x` through 100%, 150% and 200%. Check text sharpness, full-window fit,
   prompt/caret alignment, and layout in Zen, Fleet, Memory and Settings.
   Try `j`/`k`, typing and view navigation with both sensors off, then on. Check
   a long conversation and scroll anchoring while new replies arrive.

Optional local timing diagnostics in the webview inspector:

```js
window.gsvInputTiming.reset();
// Type and navigate, then inspect the aggregate timings:
window.gsvInputTiming.read();
```

This reports p95 dispatch delay, p95 time to the next animation frame, and the
maximum next-frame delay for up to 200 keyboard and 200 input events. Samples
stay in memory and contain no keys, text, targets or conversation content. This
is a frontend scheduling diagnostic, not a measurement of final display latency.

## Current limits

- Minimized webview suspension interrupts dictation. This is explicit fail-closed
  behavior for the prototype, not production native parity.
- Desktop CLI controls, tray, automatic local machine enrollment, persistent
  microphone preference and native global shortcuts are not yet connected.
  Fleet's ordinary enrollment UI remains available. Chat requires no daemon.
- OAuth, password recovery, invitations and onboarding links open in the external
  browser. The prototype does not accept external deep links or remote webviews.
- Linux is the initial build. macOS permission descriptions are included for a
  later isolated app bundle; this is not a signed/notarized macOS artifact and
  does not advertise Windows Desktop support.
- No performance improvement is claimed. Compare the whole host, webview and
  helpers against GPUI for startup, idle load, input/IME and long conversations.

The user's latest instruction authorizes building and opening the app locally;
interaction testing is performed by the user. Added boundary tests are for CI
and have not been run locally.
