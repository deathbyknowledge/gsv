# GSV native interface prototype

This crate is the client-only proof of GSV’s text-first native interface. The current work stays
focused on making the interaction model and direct gateway client feel trustworthy.

The product invariant is one conversational moment at a time. History is a spatial timeline, a
draft temporarily occupies the same canvas as the current moment, and implementation detail stays
behind human activity language. Capability approvals remain explicit and inspectable. The terminal
is a separate expert surface, not a dashboard panel.

## Run the interface study

From the repository root:

```bash
cargo run --manifest-path native/Cargo.toml -- --demo
```

The demo uses deterministic local fixture responses and does not need a gateway. Add `--mute` to
disable the procedural typing sounds. Add `--reduce-motion` (or set `GSV_REDUCE_MOTION=1`) to
disable canvas entrance motion.

To connect to GSV instead, omit `--demo`. Desktop uses the shared `gsv-client` and `gsv-config`
crates, reads the normal CLI config at `~/.config/gsv/config.toml`, and chooses the most recently
active interactive process. If none exists, it starts one.

When connection details are missing, the app opens a full-screen sequence for the gateway URL,
username, and password. Known values are skipped, and an unexpired CLI session token skips login
entirely. A successful interactive connection remembers the URL and username in the CLI config;
the password is never saved. `ws://` is accepted only for localhost development, while remote
gateways require `wss://`.

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
cargo run --manifest-path cli/Cargo.toml -- \
  --url ws://localhost:8787/ws auth setup
cargo run --manifest-path cli/Cargo.toml -- \
  --url ws://localhost:8787/ws auth login
```

Then start the native client in a second terminal:

```bash
cargo run --manifest-path native/Cargo.toml
```

The app reuses the CLI’s cached login when one exists; otherwise enter the local URL and account in
the native connection flow. It reconnects without replaying commands, restores history before
applying live deltas, and preserves an unsent or ambiguously delivered thought visibly. Wayland is
selected automatically when `WAYLAND_DISPLAY` is present; no Cargo feature is needed.

### Run experimental local gesture controls

The optional vision helper is a separate Rust process. It owns the camera,
MediaPipe inference, and temporal gesture recognition; it never sends frames or
landmarks to Desktop or the gateway. Build the pinned Linux x86-64 artifact and
helper, then opt in explicitly. Headless controls use:

```bash
./scripts/vision-mediapipe/build-linux.sh
cargo build --package gsv-vision
GSV_GESTURES=1 cargo run --manifest-path native/Cargo.toml
```

To see the camera, landmarks, scores, and the same live recognizer while testing:

```bash
GSV_GESTURE_DEBUG=1 cargo run --manifest-path native/Cargo.toml
```

The MediaPipe build uses Bazel and its hermetic Python toolchain, but neither
Python nor Bazel is a runtime dependency. The running proof consists of the
Rust `gsv-vision` helper, the compiled native library, and the verified local
model. During active dictation, two open palms explicitly arm the persistent
gesture mode. Open palm + victory explicitly disarms it; open palm + thumbs-up
commits and sends the current utterance, including while the microphone is
muted, then keeps the same microphone session listening for the next utterance;
open palm + thumbs-down requests mute; and open palm + pointing-up requests
unmute. A closed fist and all other pairs are reserved and have no action.
Arming and applied mute state survive an utterance send. The dictation shortcut
still explicitly finishes the overall voice session. Applied mute state changes
only after the transcription helper
acknowledges that its input gate is applied or reopened. The device and stream
stay open; while muted, new samples are discarded before queueing or inference.
Desktop and the diagnostic overlay show whether controls are starting,
disarmed, armed, muting, muted, or unmuting. As a supported pose accumulates
evidence, both surfaces show the same filled clockwise disk; it is presentation
only and never triggers an action. Tracking loss does not disarm the persistent
mode. Press `Escape` or close the diagnostic window to stop debug mode without
closing Desktop. See
`native/vision-helper/README.md` for thresholds, artifacts, and the override
contract. Gesture controls remain experimental and are not packaged in a
release yet.

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
  `cargo build --release --manifest-path native/transcribe-helper/Cargo.toml`. Workspace builds place
  it under the root `target/release` directory. For a distributable build, place that helper and its
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
- Process-owned image attachments use `proc.media.read`. Remote HTTP and HTTPS Markdown images are
  fetched automatically inside the trusted conversation boundary. The selected moment owns each
  transfer and cancels it on navigation; transfer, decoded-image, concurrency, and cache budgets
  keep media work bounded.
- Drafts can contain up to 20 files and 48 MiB total. Selection snapshots bytes into a private
  app-owned directory off the UI thread; `proc.media.write` streams each snapshot once before
  `proc.send`, and failed staging is rolled back. An uncertain send keeps its exact media
  descriptors for authoritative history reconciliation instead of deleting a possibly accepted
  upload.
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
cargo fmt --manifest-path native/Cargo.toml --check
cargo test --manifest-path native/Cargo.toml
cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings
```
