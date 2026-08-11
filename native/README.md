# GSV native interface prototype

This crate is the client-only proof of GSV’s text-first native interface. It deliberately leaves
the existing CLI and `gsvd` service packaging untouched: the interaction model should earn that
integration before the daemon boundary changes.

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
disable the procedural typing sounds.

To connect to GSV instead, omit `--demo`. The client reuses the public Rust client and protocol from
`cli/`, reads the normal CLI config at `~/.config/gsv/config.toml`, and chooses the most recently
active interactive process. If none exists, it starts one. These environment variables override
the config when set:

- `GSV_URL`
- `GSV_USER`
- `GSV_PASSWORD`
- `GSV_TOKEN`
- `GSV_NATIVE_PID` to pin a process

## Interaction grammar

- Start typing anywhere to replace the visible moment with a draft.
- `Enter` creates a paragraph.
- `Cmd/Ctrl+Enter` submits a conversational thought.
- `Escape` returns to the moment without discarding the draft.
- `Alt+Up` and `Alt+Down` move through moments; the rail markers are also clickable and scrollable.
- `Cmd/Ctrl+.` stops the active run.
- `Cmd/Ctrl+\`` switches between conversation and command surfaces.
- In the command surface, `Enter` runs the current command.

When GSV asks for capability approval, the only accepted responses are `allow once`, `always
allow`, and `deny` (with a few direct synonyms). Approval text is not forwarded to the model.

## Current boundary

- Streaming `proc.run.*` signals become one mutable intelligence moment.
- Tool calls are represented only as quiet activity state; raw tool cards are not shown.
- `proc.hil` approval remains a deterministic control boundary.
- The command surface currently uses one-shot `shell.exec`; it is not a persistent PTY yet.
- Attachments, process management, settings, daemon lifecycle, and `gsvd` extraction are out of
  scope for this prototype.

Validate with:

```bash
cargo fmt --manifest-path native/Cargo.toml --check
cargo test --manifest-path native/Cargo.toml
cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings
```
