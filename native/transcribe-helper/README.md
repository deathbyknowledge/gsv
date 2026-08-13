# GSV voice helper

`gsv-transcribe` is the native app's isolated local dictation worker. It owns microphone capture,
model download and verification, and streaming inference in a separate process. The GPUI process
only exchanges bounded newline-delimited JSON commands and text snapshots with it; if the helper
stalls, crashes, or exhausts its own resources, the app kills it and remains usable for typing.
At startup the helper emits `{"type":"hello","protocol_version":2}` before accepting commands.
Desktop requires that exact version and terminates a missing or mismatched helper, so an older
helper cannot silently reinterpret a newer microphone-selection or lifecycle command.

Build it separately from the UI:

```bash
cargo build --release --manifest-path native/transcribe-helper/Cargo.toml
```

On Ubuntu/Debian, the build needs a C/C++ toolchain, CMake, pkg-config, and ALSA development
headers (`build-essential cmake pkg-config libasound2-dev`). macOS builds need a complete Xcode
installation selected with `xcode-select`; Command Line Tools alone cannot compile the Metal
shaders used by the native inference library.

Place `gsv-transcribe` beside `gsv-native`, or set `GSV_TRANSCRIBE_HELPER` to its absolute path for
development. Debug app builds also discover either a release or debug helper in the workspace
`target` directory. Ship `THIRD_PARTY.md` beside the helper in distributable packages.
`Cmd/Ctrl+Shift+Space` starts or finishes dictation. The first use downloads and SHA-256 verifies
the pinned 534 MiB Q5 model. Concurrent app instances serialize preparation with a cache lock and
resume a stable partial download only after the pinned server response confirms the exact remaining
byte range; the completed file is always SHA-256 verified before installation. Download, verification,
and loading happen on a preparation worker so Stop, Cancel, and Shutdown remain responsive. Protocol
events expose only bounded phases and error codes, never native diagnostics, paths, or model choices.
The model and compute backend are deliberately not product settings; `GSV_TRANSCRIBE_MODEL` and
`GSV_TRANSCRIBE_ACCELERATION=1` are development overrides only.

An idle client can discover microphone names without preparing the model by sending
`{"type":"list_devices","request_id":1}`. The correlated response is
`{"type":"devices","request_id":1,"devices":[{"id":"host:opaque-id","name":"Built-in microphone","is_default":true}]}`.
The helper publishes at most 32 inputs with a human-readable name (at most 256 UTF-8 bytes), an
opaque CPAL device ID (at most 512 UTF-8 bytes), and the detected default marker. Desktop persists
the ID with its display name but never exposes the ID through general status, logs, or the public
Desktop control protocol. Discovery during model preparation or an active transcription returns the
existing `busy` error; an audio-backend enumeration failure returns `microphone_unavailable`.

Discovery runs on one owned worker so commands and shutdown remain responsive if the OS audio API
is slow. `{"type":"cancel","request_id":1}` immediately returns a correlated `cancelled` event and
suppresses any late discovery result. A new discovery or transcription remains `busy` until that
worker actually exits; the client supervisor owns the deadline and may replace a helper whose OS
call is stuck because Rust cannot safely terminate an individual thread.

Starts using a selection returned by discovery pass its opaque ID:
`{"type":"start","request_id":2,"locale":"auto","device":"Built-in microphone","device_id":"host:opaque-id","exact_device":true}`.
The helper resolves that ID directly, verifies that its current display name still matches, and
never falls back to another device when it is gone or the identifier was reassigned. Exact
public-name matching remains only for migration from a legacy saved name; it is byte-for-byte,
case-sensitive, and must identify exactly one device. Omitting `exact_device` retains the legacy
case-insensitive unique-substring behavior
for temporary development overrides only.

The helper defaults to CPU, limits a transcription session to ten minutes and 64 KiB of text, uses
at most four worker threads, lowers its Unix scheduling priority, bounds microphone and IPC queues,
and runs only one session at a time. It unloads the model after five idle minutes. On macOS, the
acceleration override selects Metal. UI updates carry an append-only committed prefix and a
replaceable tentative suffix, throttled below frame rate; client backpressure retains only the
latest complete snapshot.
