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

To connect to GSV instead, omit `--demo`. The client reuses the public Rust client and protocol from
`cli/`, reads the normal CLI config at `~/.config/gsv/config.toml`, and chooses the most recently
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

## Interaction grammar

- Start typing anywhere to replace the visible moment with a draft.
- `Enter` submits the current thought or runs the current command.
- `Cmd/Ctrl+Enter` or `Shift+Enter` creates a new line.
- `Escape` returns to the moment without discarding the draft.
- The mouse wheel, `Alt+Up`, and `Alt+Down` move through moments; rail markers are also clickable.
- `Cmd/Ctrl+.` stops the active run.
- `Cmd/Ctrl+\`` switches between conversation and command surfaces.

When GSV asks for capability approval, the only accepted responses are `allow once`, `always
allow`, and `deny` (with a few direct synonyms). Approval text is not forwarded to the model.

## Current boundary

- Streaming `proc.run.*` signals become one mutable intelligence moment.
- Completed intelligence replies render a conservative GFM subset: headings, emphasis, links,
  lists, quotes, tables, rules, inline and fenced code, and Markdown images. Partial streaming
  Markdown remains literal until the reply completes so its layout does not churn while tokens
  arrive.
- Process-owned image attachments use `proc.media.read`. Remote HTTP and HTTPS Markdown images are
  fetched automatically inside the trusted conversation boundary. The selected moment owns each
  transfer and cancels it on navigation; transfer, decoded-image, concurrency, and cache budgets
  keep media work bounded.
- Audio, video, and document attachments currently render as typed metadata cards, including a
  transcription or description when one exists. Native playback and document preview are later
  surfaces.
- Tool calls are represented only as quiet activity state; raw tool cards are not shown.
- `proc.hil` approval remains a deterministic control boundary.
- The command surface currently uses one-shot `shell.exec`; it is not a persistent PTY yet.
- Attachment composition/upload, process management, settings, and daemon lifecycle are out of
  scope for this prototype.

Validate with:

```bash
cargo fmt --manifest-path native/Cargo.toml --check
cargo test --manifest-path native/Cargo.toml
cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings
```
