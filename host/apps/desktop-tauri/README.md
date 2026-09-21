# GSV Tauri Prototype

An isolated executable hosting the real Instrument/Zen frontend. It reuses the
production native helper supervisors through `desktop-native`. Production GPUI
Desktop, its credentials, daemon, CLI endpoint and installer remain separate.
The ownership record is [here](../../../../engineering/desktop-tauri-prototype.md).

The requested prototype features are implemented and the local executable builds.
Final human acceptance and CI verification remain open. The user confirmed that
the WebKit/NVIDIA exit workaround resolves the local quit crash. Production replacement,
native feature parity and supported-platform distribution are separate from this
prototype.

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

On Linux with the NVIDIA kernel module loaded, the host also defaults
`WEBKIT_SKIA_GPU_PAINTING_THREADS` to `0` before starting GTK or any runtime
threads. This avoids the GPU-worker cleanup path implicated in the local exit
crash. WebKit still paints with the GPU, but schedules that painting on its main
thread; compare responsiveness when qualifying other GPU/driver combinations. An
explicit value for this environment variable takes precedence. This is an
app-local mitigation for the observed WebKitGTK 2.52.6/NVIDIA 610.57.04 failure,
not a driver fix. See
[WebKit's painting modes](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebCore/platform/graphics/skia/SkiaPaintingEngine.cpp#L49-L54).

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

Closing the window, including Super+W on the prototype Linux machine, exits the
prototype and shuts down its helpers. Close and the visible Quit action use the
same path, confirming only when a retained view has unsaved work. The ordinary
installed Desktop can be opened as usual. `gsv desktop` continues to address
that installed application: this prototype does not claim its local CLI control
endpoint.

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
2. Open Voice beside Attach, then start listening. Check preparation, partial text,
   pause/cancel and device selection. Type before/after the dictated range. Editing
   inside dictated text stops capture and preserves the correction; restart Voice to
   continue. Enter while listening uses ordinary conversation sending, preserves
   files and keeps the microphone on. Opening controls alone must not capture
   microphone audio; closing them must not silently stop active dictation.
3. Open Hands-free and enable it: Ready means camera on, microphone off. One
   finger starts or pauses listening, two sends, three deletes, and four clears
   dictated text. Holding both fists turns hands-free off. Check fist reset, the scroll
   chord and tracking loss. The control shows state, hold progress and accepted
   commands; its panel contains the hand guide. Clear/delete affect only unsent
   dictated text. The panel closes with Escape or an outside click, without
   resizing the conversation. All
   feedback stays outside the editable draft.
   Compare index + middle + ring with thumb + index + middle: both must be three
   and delete a dictated character, never send. Try other combinations for the
   same count, a thumb alone, partially bent digits, and a fist between commands.
   The guide's selectors play examples without enabling the camera. Check both
   hands for shutdown and scrolling, draggable demonstrations, and reduced-motion
   stills. Start tutorial and check automatic progression, corrective feedback
   for a wrong gesture, local dictation, completion, and capture stopping on close.
4. Try unfocused use and minimization. If the webview stops responding for three
   seconds, native input stops. Reconnect native input and explicitly
   restart it. No old action should arrive in a later draft. Repeat after sleep,
   reload, Process selection change and logout.
5. Disconnect the space, then select another destination. Its username may also
   be `root`; it must show fresh sign-in with no old history, draft, uploads,
   pending sends or terminal recovery. The disconnect action warns about unsent
   work and tears down the whole frontend.
6. Quit and reopen. Camera and microphone must be off. The independent
   daemon and installed Desktop should remain available.
   Repeat with the window manager's Close action (Super+W): with no unsaved work
   it should exit directly; with a draft it should offer Keep working or Quit.
   Keep working must preserve the draft, including one in a hidden view. Repeat
   with a Fleet inspector open: the quit confirmation must appear above it.
7. Cycle `x` through 100%, 150% and 200%. Check text sharpness, full-window fit,
   prompt/caret alignment, and layout in Zen, Fleet, Memory and Settings.
   At each size, open Voice and Gestures: their panels should use the available
   reading area, with ordinary scrolling only when the guide is taller than it.
   Try `j`/`k`, typing and view navigation with both sensors off, then on. Check
   a long conversation and scroll anchoring while new replies arrive.
8. Leave your own unsent draft and attachments in Zen, select some text, and
   scroll to an older message. Visit Fleet, Memory and Settings using the header,
   then return: switching views should show no discard dialog and retain the
   draft, selection and reading position. Repeat with a Fleet form, a Memory
   edit and a Settings draft, including their current selection and scroll.
   Hidden views must not respond to the visible view's shortcuts. Check a reply
   that arrives while away, and compare typing/browsing after visiting all four
   views. This retention lasts for the signed-in session; it is not restart
   recovery or automatic saving. Leaving Zen stops native input as before.
9. In Memory, move with j/k or the arrow keys across pages and closed folders.
   Only the row highlight should move; the current page must stay put. Space or
   Enter should toggle a folder or open a page. A closed folder's descendants
   should be skipped. Repeat in search results, then with an unsaved edit:
   highlighting another row must not discard or ask to discard the edit;
   intentionally opening another page still protects it. Check that typing
   spaces and j/k in the search/editor fields retains ordinary text behavior.
10. In Fleet, use j/k across places, processes, contacts, work, ledger rows and
    files. Only focus should move: no inspector should appear and no file or
    process-detail read should result from highlighting. Click, Space or Enter
    should open a centered inspector; a folder should expand in place. Escape,
    close and a backdrop click should return focus to the opener. Check scrolling
    and contact messages in the dialog at 100%, 150% and 200% zoom. Close and
    reopen a routine editor with a draft, then switch views and return: it should
    retain the edit. Opening another item still protects unsaved routine edits.
    Check an expanded file, its return to the preview, explicit pagination and
    links into Fleet from Zen. Closed inspectors should pause their queries.
11. Run two direct commands in succession. Sending should leave `$ ` ready for
    the next command, with command history available from that empty prefix.
    Delete `$ ` to return to messages. Empty `$` must neither run nor send, and
    must not trigger an unsaved-draft warning. Pending output should show the
    shared spinner; stopped, failed and unavailable states should remain clear.

For responsiveness, compare mouse-wheel scrolling with `j`/`k` at the same zoom
and window size. Include long messages, receipts, loading earlier history, prompt
typing, and tapped or held cursor keys. The temporary input-timing panel, F8
shortcut, and timing collectors have been removed.

## Current limits

- On the prototype NVIDIA machine, repeated WebKitWebProcess cores show GPU-worker
  crashes during graphics teardown on exit. The host now avoids those workers;
  the user confirmed clean exit with this mitigation on September 21.
  See the ownership record for the diagnosis.
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
