# GSV voice helper

The `transcriber` package builds Desktop's isolated `gsv-transcribe` dictation
worker. It owns microphone capture, model download and verification, and
streaming inference in a separate process. The GPUI process only exchanges
bounded newline-delimited JSON commands and text snapshots with it; if the
helper stalls, crashes, or exhausts its own resources, the app kills it and
remains usable for typing.
At startup the helper emits
`{"type":"hello","protocol_version":2,"contract":"gsv-voice-v2-continuous-segments"}` before
accepting commands. Desktop requires that exact version, contract marker, and field set and
terminates a missing or mismatched helper, so a stale sibling cannot silently reinterpret a newer
microphone-selection, mute, or lifecycle command. The private contract marker is rotated for an
incompatible unshipped cutover without changing the numeric v2 protocol.

Build it separately from the UI:

```bash
cargo build --release --manifest-path host/helpers/transcriber/Cargo.toml
```

On Ubuntu/Debian, the build needs a C/C++ toolchain, CMake, pkg-config, and ALSA development
headers (`build-essential cmake pkg-config libasound2-dev`). macOS builds need a complete Xcode
installation selected with `xcode-select`; Command Line Tools alone cannot compile the Metal
shaders used by the native inference library.

Place `gsv-transcribe` beside `gsv-desktop`, or set `GSV_TRANSCRIBE_HELPER` to its absolute path for
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

On Linux the helper prefers CPAL's PulseAudio protocol host, which also works through PipeWire's
PulseAudio compatibility service. It publishes logical capture sources and omits output-monitor sources;
Desktop owns the separate `SYSTEM DEFAULT` choice. If that service is unavailable, the conservative
ALSA fallback publishes one conversion-capable physical selector per PCM and omits ALSA's duplicate
direct, card-default, front, processing-plugin, and sound-server aliases.

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

An active request accepts idempotent, request-scoped streaming mute commands such as
`{"type":"set_muted","request_id":2,"muted":true}`. The helper publishes an initial
`mute_state` at revision zero and a monotonically increasing, authoritative
`{"type":"mute_state","request_id":2,"revision":1,"muted":true}` acknowledgement for every
accepted command. A different or inactive request receives `not_active` and cannot change the
capture gate. Stop, Cancel, and Shutdown remain available while muted.

An active request can finalize one utterance without releasing the microphone by sending
`{"type":"commit_segment","request_id":2,"segment_id":0}`. The helper finalizes that model
stream, begins segment 1 with the same capture request and acknowledged mute state, then publishes
the reliable, nonterminal
`{"type":"segment_final","request_id":2,"segment_id":0,"text":"..."}` boundary. Partial
snapshots carry their segment ID because the model-local revision restarts for every fresh stream.
Only `stop` produces the terminal `final` event and releases capture. Segment IDs must be exact and
monotonic; a disagreement fails the active request closed rather than committing ambiguous audio.
Desktop uses this same boundary before sending, deleting one visible Unicode character (grapheme),
or clearing the voice-owned draft, so later partials start from a fresh segment and cannot restore
corrected text.

Muting keeps the selected microphone device and CPAL stream open. An atomic request-generation
gate rejects newly captured frames before mono conversion and queueing, and the inference loop
drops queued packets from an invalidated generation, clears its pending audio, and resets its
resampler and pending exact-zero startup check. Unmuting drains and resets again, opens a fresh
capture generation, and never replays audio captured or queued before the transition. A native
inference feed that was already entered may finish before the `mute_state` acknowledgement; that
acknowledgement is the applied boundary, after which no packet from an older generation can enter a
later feed. Segment commit uses the same generation fence: command ingress temporarily closes the
callback gate, the active loop waits for admitted callbacks and feeds the bounded queued tail into
the old model stream, then reopens the prior mute state on a fresh generation before finalization.
Audio arriving after that boundary queues only for the next segment. No VAD, silence countdown, or
automatic send behavior is part of this protocol.

The helper defaults to CPU, limits the whole capture request to ten minutes and each segment to
64 KiB of text, uses
at most four worker threads, lowers its Unix scheduling priority, bounds microphone and IPC queues,
and runs only one session at a time. It unloads the model after five idle minutes. On macOS, the
acceleration override selects Metal. UI updates carry an append-only committed prefix and a
replaceable tentative suffix, throttled below frame rate; client backpressure retains only the
latest complete snapshot.
