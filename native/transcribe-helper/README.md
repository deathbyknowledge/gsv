# GSV voice helper

`gsv-transcribe` is the native app's isolated local dictation worker. It owns microphone capture,
model download and verification, and streaming inference in a separate process. The GPUI process
only exchanges bounded newline-delimited JSON commands and text snapshots with it; if the helper
stalls, crashes, or exhausts its own resources, the app kills it and remains usable for typing.

Build it separately from the UI:

```bash
cargo build --release --manifest-path native/transcribe-helper/Cargo.toml
```

On Ubuntu/Debian, the build needs a C/C++ toolchain, CMake, pkg-config, and ALSA development
headers (`build-essential cmake pkg-config libasound2-dev`). macOS builds need a complete Xcode
installation selected with `xcode-select`; Command Line Tools alone cannot compile the Metal
shaders used by the native inference library.

Place `gsv-transcribe` beside `gsv-native`, or set `GSV_TRANSCRIBE_HELPER` to its absolute path for
development. Debug app builds also discover either a release or debug helper in this crate's
`target` directory. Ship `THIRD_PARTY.md` beside the helper in distributable packages.
`Cmd/Ctrl+Shift+Space` starts or finishes dictation. The first use downloads and SHA-256 verifies
the pinned 534 MiB Q5 model. Concurrent app instances serialize preparation with a cache lock and
resume a stable partial download only after the pinned server response confirms the exact remaining
byte range; the completed file is always SHA-256 verified before installation. Download, verification,
and loading happen on a preparation worker so Stop, Cancel, and Shutdown remain responsive. Protocol
events expose only bounded phases and error codes, never native diagnostics, paths, or model choices.
The model and compute backend are deliberately not product settings; `GSV_TRANSCRIBE_MODEL` and
`GSV_TRANSCRIBE_ACCELERATION=1` are development overrides only.

The helper defaults to CPU, limits a transcription session to ten minutes and 64 KiB of text, uses
at most four worker threads, lowers its Unix scheduling priority, bounds microphone and IPC queues,
and runs only one session at a time. It unloads the model after five idle minutes. On macOS, the
acceleration override selects Metal. UI updates carry an append-only committed prefix and a
replaceable tentative suffix, throttled below frame rate; client backpressure retains only the
latest complete snapshot.
