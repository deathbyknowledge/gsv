# GSV Desktop

This application is the client-only proof of GSV’s text-first Desktop interface. The current work stays
focused on making the interaction model and direct gateway client feel trustworthy.

The product invariant is one conversational moment at a time. History is a spatial timeline, a
draft temporarily occupies the same canvas as the current moment, and implementation detail stays
behind human activity language. Capability approvals remain explicit and inspectable. The terminal
is a separate expert surface, not a dashboard panel.

## Run the interface study

From the repository root:

```bash
cargo run --manifest-path host/apps/desktop/Cargo.toml -- --demo
```

The demo uses deterministic local fixture responses and does not need a gateway. Add `--mute` to
disable the procedural typing sounds. Add `--reduce-motion` (or set `GSV_REDUCE_MOTION=1`) to
disable canvas entrance motion.

To connect to GSV instead, omit `--demo`. Desktop uses the shared `gateway-client` and `host-config`
crates, reads the normal CLI config at `~/.config/gsv/config.toml`, and chooses the most recently
active interactive process. If none exists, it starts one.

When connection details are missing, the app opens a full-screen sequence for the gateway URL,
username, and password. Known values are skipped, and an unexpired CLI session token skips login
entirely. A successful interactive connection remembers the URL and username in the CLI config;
the password is never saved. `ws://` is accepted only for localhost development, while remote
gateways require `wss://`.

After the first authenticated connection, Desktop asks what to call the local computer. Choosing
`CONNECT COMPUTER` creates one driver-bound machine credential, saves it in the shared private
`config.toml`, and installs/starts the sibling `gsvd` as a per-user background service through the
bundled `gsv` executable. Desktop verifies the daemon through its same-user local control protocol;
the credential is never passed in command-line arguments. `NOT NOW` keeps Desktop usable without a
machine target. A retry reuses any already-saved identity instead of creating another machine.

These environment variables remain optional overrides for automation and development:

- `GSV_URL`
- `GSV_USER`
- `GSV_PASSWORD`
- `GSV_TOKEN`
- `GSV_NATIVE_PID` to pin a process

### Run against the local development gateway

Build the web assets once, then keep the local worker stack running in one terminal:

```bash
npm run build --workspace web
npm run dev
```

For a clean development state, initialize it once with the CLI (or complete setup in the web UI):

```bash
cargo run --manifest-path host/apps/cli/Cargo.toml -- \
  --url ws://localhost:8787/ws auth setup
cargo run --manifest-path host/apps/cli/Cargo.toml -- \
  --url ws://localhost:8787/ws auth login
```

Then start Desktop in a second terminal:

```bash
cargo run --manifest-path host/apps/desktop/Cargo.toml
```

The app reuses the CLI’s cached login when one exists; otherwise enter the local URL and account in
the Desktop connection flow. It reconnects without replaying commands, restores history before
applying live deltas, and preserves an unsent or ambiguously delivered thought visibly. Wayland is
selected automatically when `WAYLAND_DISPLAY` is present; no Cargo feature is needed. Desktop owns
one operating-system status item for connection, machine, voice, and gesture state. Its Gateway
action opens sign-in or forces an immediate reconnect. Its machine actions start or restart the
installed service through the bundled `gsv` executable, request a reconnect over the typed local
control protocol, and show bounded redacted diagnostics. Closing the
window hides it on macOS or minimizes it on Windows/Linux; use the status menu or app launcher to
open it again. `Cmd/Ctrl+Q` and **Quit GSV** stop Desktop and its local helpers, while the installed
`gsvd` service keeps the computer connected.

Linux uses the freedesktop StatusNotifier protocol directly and adds no native tray build
dependency. KDE and other StatusNotifier-aware desktops show it directly. GNOME generally needs an
AppIndicator/StatusNotifier shell extension. Desktops without a StatusNotifier host can still run
GSV normally; showing the status item is best effort.

### Run experimental local gesture controls

The gesture helper is a separate Rust process. It owns the camera, native
Rust/tract inference, and temporal gesture recognition; it never sends frames
or landmarks to Desktop or the gateway. Desktop starts it automatically when
the helper is available. Build both from the host workspace; no separate model
download is required:

```bash
cargo build --manifest-path host/Cargo.toml --package gestures --package desktop
cargo run --manifest-path host/Cargo.toml --package desktop
```

Set `GSV_GESTURES=0` to disable the helper explicitly.

To see the camera, landmarks, scores, and the same live recognizer while testing:

```bash
GSV_GESTURE_DEBUG=1 cargo run --manifest-path host/apps/desktop/Cargo.toml
```

The helper embeds checksum-pinned TFLite models and uses tract, with no Python,
Java, Bazel, or native MediaPipe dependency. Gesture control starts disarmed. Hold
both hands in fists for 700 ms to arm or disarm it. Once armed, the physical
right hand acts alone by opening fingers in order: 1 starts or finishes
transcription, 2 sends and keeps listening, 3 deletes one visible character
from unsent dictation, 4 clears the unsent dictated text after a one-second
hold, and 5 mutes or unmutes. Return the right hand to a fist between every
number command. Because arming is a deliberate two-hand action, numbered
commands remain available while Desktop is in the background. Disarming turns
off gesture commands without stopping an active transcription. Desktop owns
and visibly echoes the armed state. Typed text and attachments survive
correction gestures, applied mute state survives an utterance send, and the
dictation shortcut remains the equivalent explicit Start/Stop control.

Scrolling uses both hands so it cannot collide with the fist reset. Hold the
control hand open and settle the action fist briefly; that captures the angle
of the line between both palm centers as neutral. Raise or lower the fist
relative to the control palm to change continuous scroll speed. Returning to
the neutral angle pauses, moving both hands together does not scroll, and
releasing either posture ends the chord. Each measured angle maps directly to
velocity without a dead zone or smoothing; tracking loss stops the scroll, and
a fresh action fist is required before an opened action hand can become another
numbered command. Desktop validates fresh armed state and applies the velocity
directly to its existing view-scroll policy: a long message scrolls to its edge
before continued movement changes moments. This path needs no window focus or
synthetic operating-system input.

When gestures are enabled, choose `GESTURES · ⌘⇧G` in Desktop or press
`Command/Ctrl+Shift+G` for the complete posture and timing cheat sheet. It can
remain open while practicing; `Escape` closes it before affecting dictation or
the current draft. Desktop and the diagnostic overlay show the same bounded
gesture progress, but that presentation never triggers an action. Tracking
loss never starts, stops, sends, edits, mutes, or unmutes a session. Press
`Escape` or close the diagnostic window to stop debug mode without closing
Desktop. See
`host/helpers/gestures/README.md` for thresholds, artifacts, and the override
contract. Gesture controls remain experimental and are not packaged in a
public release yet. The unsigned macOS development bundle includes the helper
and its pinned models for technical dogfooding.

### Package the macOS development application

On a Mac, build and assemble Desktop, `gsv`, `gsvd`, both local helpers, the
gesture models, the icon, and camera/microphone permission metadata into one
application:

```bash
./host/scripts/package-macos.sh --debug
open "host/target/package/macos/$(uname -m)/debug/GSV.app"
```

Use `--release` for optimized binaries. This produces an unsigned `GSV.app`
and ZIP for internal testing; public distribution still requires Developer ID
signing and Apple notarization. The transcription model remains a verified
first-use download rather than adding roughly 534 MiB to every application.

## Interaction grammar

- Start typing anywhere to replace the visible moment with a draft.
- `Enter` submits the current thought or runs the current command.
- `Cmd/Ctrl+Enter` or `Shift+Enter` creates a new line.
- `Escape` returns to the moment without discarding the draft.
- The mouse wheel, `Alt+Up`, and `Alt+Down` move through moments; rail markers are also clickable.
- On a long moment, the wheel scrolls its contents first; at an edge, three continued wheel detents
  move to the adjacent moment. A wheel gesture over the left rail moves one moment directly.
- Drag across reply or terminal text to select it; `Cmd/Ctrl+C` copies the exact visible text.
- `Cmd/Ctrl+Shift+Space` starts local streaming dictation. Speak after `LISTENING`; words appear in
  the draft as they are recognized. Press the same shortcut again (or press `Enter`) to finish it.
  On first use, Desktop asks which input to remember, including `SYSTEM DEFAULT`; reopen that calm,
  full-canvas chooser with `Cmd/Ctrl+Shift+M`. The running Desktop can also list or change the saved
  choice with `gsv desktop microphone list`, `gsv desktop microphone use "Shure MV6"`, and
  `gsv desktop microphone default`. `GSV_VOICE_DEVICE="Shure MV6"` is a temporary developer override
  with precedence over the saved preference; changing the saved choice does not clear the override.
  Build the isolated helper first with
  `cargo build --release --manifest-path host/helpers/transcriber/Cargo.toml`. Workspace builds place
  it under `host/target/release`. For a distributable build, place that helper and its
  `THIRD_PARTY.md` beside the app binary.
- `Cmd/Ctrl+.` stops the active run.
- `Cmd/Ctrl+Shift+A` opens the attachment picker. Text is optional when files are attached.
- `Cmd/Ctrl+\`` switches between conversation and command surfaces.

The operator CLI can activate the running app, inspect its redacted connection status, or ask the
app to create/select a conversation through its private same-user control socket:

```bash
gsv desktop
gsv desktop status
gsv desktop new
gsv desktop use PID
gsv desktop microphone list
gsv desktop microphone use "Shure MV6"
gsv desktop microphone default
```

When GSV asks for capability approval, choose `ALLOW ONCE`, `ALWAYS ALLOW`, or `DENY` directly, or
type the same phrases. The request uses the Process-resolved target and a safe action preview;
approval text is not forwarded to the model.

## Current boundary

- Streaming `proc.run.*` signals become one mutable intelligence moment.
- Intelligence replies render a conservative GFM subset while they stream: headings, emphasis,
  links, lists, quotes, tables, rules, inline and fenced code, and Markdown images. Preparation is
  coalesced off the UI thread and publishes coherent snapshots rather than splicing an unparsed
  token tail into rendered Markdown. An identical completed reply reuses its final streamed
  document and type size instead of reparsing or reshaping at completion.
- Immutable file references resolve lazily through streamed `fs.transfer.send` bodies. Remote HTTP
  and HTTPS Markdown images are fetched automatically inside the trusted conversation boundary.
  The selected moment owns each transfer and cancels it on navigation; transfer, decoded-image,
  concurrency, and cache budgets keep media work bounded.
- Drafts can contain up to 20 files and 48 MiB total. Selection snapshots bytes into a private
  app-owned directory off the UI thread; `fs.transfer.receive` streams each snapshot to a temporary
  GSV path before `conversation.send`, and failed staging is removed. An uncertain send keeps its
  exact immutable reference for authoritative history reconciliation instead of deleting a
  possibly accepted upload.
- Audio, video, and document attachments render as typed metadata cards, including a transcription
  or description when one exists. `OPEN` materializes the bounded process body into a private
  session directory and delegates playback or preview to the operating system; `SAVE` uses the
  native save picker. Unknown content is written without an executable filename extension.
- Existing run and tool signals become a prominent, client-derived live lane above the moment.
  Parallel work is grouped into a few calm, category-specific status lines. Completed tool
  results from process history are retained as quiet, line-by-line work records on the final
  response; raw tool names, arguments, paths, outputs, and tool cards are not shown.
- `proc.hil` approval remains a deterministic control boundary.
- The command surface currently uses one-shot `shell.exec`; it is not a persistent PTY yet.
- General process management, settings, an embedded video/PDF renderer, and a persistent terminal
  session remain outside this client surface. Conversation creation/selection is available through
  the narrow `gsv desktop` control commands.

Validate with:

```bash
cargo fmt --manifest-path host/apps/desktop/Cargo.toml --check
cargo test --manifest-path host/apps/desktop/Cargo.toml
cargo clippy --manifest-path host/apps/desktop/Cargo.toml --all-targets -- -D warnings
```
