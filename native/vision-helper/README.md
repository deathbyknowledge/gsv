# GSV local vision helper

`gsv-vision` is an experimental local hand-control helper. It is a separate Rust
process that owns the camera, MediaPipe Gesture Recognizer, temporal gesture
policy, and optional diagnostic window. Camera pixels never enter GPUI, the
gateway, logs, files, or GSV application IPC. They are handed only to local
MediaPipe inference and, in debug mode, the OS display system. A bounded private
pipe carries a reliable session-scoped `start transcription` intent,
request-scoped `stop transcription`, `send`, `mute`, and `unmute` intents, and
absolute held-scroll state, plus replace-latest semantic control status with
bounded candidate progress. Every
active action identifies the exact voice request, and every event is scoped to
the random helper session. Reliable lifecycle, intent, and held-scroll events
share a strict monotonic sequence, while Desktop applies its bounded local
freshness policy before acting on received control.

The runtime does not require Python. It consists of this Rust executable, a
source-built native MediaPipe library, and the verified 8.0 MiB Gesture
Recognizer task bundle. Bazel and its hermetic Python toolchain are used only
to build that native artifact.

## Run on Linux x86-64

From the repository root:

```bash
./scripts/vision-mediapipe/build-linux.sh
cargo build --package gsv-vision
GSV_GESTURES=1 cargo run --manifest-path native/Cargo.toml
```

The headless mode above is the real local control path. Use the diagnostic
window against the same classifier with:

```bash
GSV_GESTURE_DEBUG=1 cargo run --manifest-path native/Cargo.toml
```

The Desktop singleton starts one helper only after Desktop itself has won
startup. Close the diagnostic window or press `Escape` to stop debug mode; the
Desktop remains open. Closing Desktop terminates the helper process even when a
camera or inference call is stuck below Rust.

The debug window mirrors presentation, but inference always receives the
original camera frame. It draws up to two 21-point hand skeletons, handedness,
canned gesture labels and confidence, a simple two-hand relationship, and
capture/inference/render timing. It also shows the semantic controller state:
DISABLED, STANDBY, TRANSCRIBING, or TRANSCRIBING + MUTED, the fixed-vocabulary
rejection, and clockwise progress through the complete temporal evidence gate.
The same bounded semantic state and quantized progress are sent to Desktop as
replace-latest presentation feedback; they cannot invoke an action. Raw labels,
scores, landmarks, and diagnostics remain inside the helper. Capture and
inference each retain only their latest value, so a slow machine drops stale
frames rather than accumulating a private video queue.

## Gesture grammar

Hand order and anatomical handedness do not assign roles. Desktop supplies one
strict absolute context: standby when there is no voice request and the helper
may propose starting one, disabled while an existing request is preparing,
stopping, or otherwise not gesture-eligible, or active with the exact listening
request and acknowledged mute state. Desktop still owns final Start admission
under transient UI policy. Keyboard-started dictation enters the same active
context; the helper has no separate persistent armed bit.

- While standby, show two open palms for 350 ms to start transcription.
- While active, show open palm + Victory for 350 ms to stop transcription.
- Show open palm + thumbs-up for 700 ms to send now.
- Show open palm + thumbs-down for 450 ms to mute explicitly.
- Show open palm + pointing-up for 700 ms to unmute explicitly.
- Show closed fist + pointing-up for 250 ms, then hold to scroll up.
- Show closed fist + thumbs-down for 250 ms, then hold to scroll down.

Scroll gestures work in either standby or active voice mode. On a long moment,
holding scrolls only that moment and stops at its edge. A fresh gesture begun at
an edge moves exactly one moment; the held gesture is then consumed until a
different known pose is observed, so it cannot skip through multiple moments.
All other canned combinations are reserved and unassigned.
Every gesture enters and continues at 0.50 confidence. After emitting any
intent, the helper blocks further commands until Desktop echoes a fresh
absolute context; an unchanged echo also resolves a rejected or nonterminal
request. The emitted pose stays latched across disabled, standby, active, and
request transitions until the helper positively observes a different known
two-hand pose at sufficient confidence. Missing, stale, invalid, or unknown
tracking cannot release this latch, so holding Start or Stop cannot loop after
an authority echo. `Send` remains nonterminal and does not end capture.

Evidence also requires the gesture-specific dwell, match count, strong-sample
count, consecutive and support thresholds, fresh frames, and bounded inference
gaps. Progress is the minimum of those aggregate gates and remains below
complete until an intent is emitted. Missing or unrecognized classifications,
stale frames, real capture gaps, and tracking loss clear only in-flight
evidence; they never start or stop transcription or change mute state. Fresh
evidence must satisfy a complete dwell after any such loss. This grammar does
not infer speech silence or implement auto-send.

## Local overrides

- `GSV_VISION_CAMERA=1` selects a numeric local camera index (default `0`).
- `GSV_MEDIAPIPE_LIBRARY=/path/to/libgesture_recognizer.so` overrides the
  source-built library.
- `GSV_VISION_MODEL=/path/to/gesture_recognizer.task` overrides the model path.
- `GSV_VISION_HELPER=/path/to/gsv-vision` tells Desktop which helper executable
  to supervise.

An explicit missing override fails closed instead of silently falling back.
The model must always match the pinned size and SHA-256 before the camera opens.
Library/model/backend paths and native diagnostics are not printed.

The artifact build contract, source patch, licenses, resource limits, and model
redistribution caveat live in [`scripts/vision-mediapipe/README.md`](../../scripts/vision-mediapipe/README.md).
The proof is not part of release packaging yet.
