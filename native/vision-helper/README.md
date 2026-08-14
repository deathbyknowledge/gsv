# GSV local vision helper

`gsv-vision` is an experimental local hand-control helper. It is a separate Rust
process that owns the camera, MediaPipe Gesture Recognizer, temporal gesture
policy, and optional diagnostic window. Camera pixels never enter GPUI, the
gateway, logs, files, or GSV application IPC. They are handed only to local
MediaPipe inference and, in debug mode, the OS display system. A bounded private
pipe carries only `hold`, `release_hold`, and `send` intents scoped to the exact
active voice request and random helper session.

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
capture/inference/render timing. Capture and inference each retain only their
latest value, so a slow machine drops stale frames rather than accumulating a
private video queue.

## Gesture grammar

Controls are enabled only while one request is authoritatively listening. Hand
order and anatomical handedness do not assign roles.

- Hold two open palms for 350 ms to enter READY. Every command must be re-armed.
- Hold open palm + closed fist for 450 ms to latch SEND HOLD. The microphone
  keeps transcribing, but gesture send is unavailable.
- Hold two open palms for 350 ms to explicitly release HOLD and return to READY.
- Hold open palm + thumbs-up for 700 ms to stop dictation, await its matching
  authoritative final transcript, and enter the normal Desktop send owner.

Entry confidence is 0.80 with continuation hysteresis at 0.65. Evidence also
requires consecutive/support thresholds, fresh frames, and bounded inference
gaps. Missing hands, low confidence, stale frames, helper failure, or tracking
loss never release HOLD. This batch does not infer speech silence or auto-send
from transcript timing; that requires a separate audio-owner activity signal.

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
