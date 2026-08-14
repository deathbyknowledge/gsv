# GSV local vision debug helper

`gsv-vision` is a development proof for local hand tracking. It is a separate
Rust process that owns the camera, MediaPipe Gesture Recognizer, and a small
diagnostic window. Camera pixels never enter GPUI, the gateway, logs, files, or
GSV application IPC. They are handed only to local MediaPipe inference and the
OS display system for the explicitly enabled diagnostic window. This proof has
no gesture-to-action mapping.

The runtime does not require Python. It consists of this Rust executable, a
source-built native MediaPipe library, and the verified 8.0 MiB Gesture
Recognizer task bundle. Bazel and its hermetic Python toolchain are used only
to build that native artifact.

## Run on Linux

From the repository root:

```bash
./scripts/vision-mediapipe/build-linux.sh
cargo build --package gsv-vision
GSV_GESTURE_DEBUG=1 cargo run --manifest-path native/Cargo.toml
```

The Desktop singleton starts one helper only after Desktop itself has won
startup. Close the diagnostic window or press `Escape` to stop the helper; the
Desktop remains open. Closing Desktop terminates the helper process even when a
camera or inference call is stuck below Rust.

The debug window mirrors presentation, but inference always receives the
original camera frame. It draws up to two 21-point hand skeletons, handedness,
canned gesture labels and confidence, a simple two-hand relationship, and
capture/inference/render timing. Capture and inference each retain only their
latest value, so a slow machine drops stale frames rather than accumulating a
private video queue.

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
