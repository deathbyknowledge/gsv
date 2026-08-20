# GSV gesture helper

The `gestures` package builds the experimental `gsv-vision` local hand-control
helper. It is a separate Rust process that owns the camera, native Rust/tract
inference, temporal gesture policy, and optional diagnostic window. Camera
pixels never enter GPUI, the gateway, logs, files, or GSV application IPC. They
are handed only to local inference and, in debug mode, the OS display
system. A bounded private pipe carries a reliable session-scoped
`start transcription` intent, request-scoped `stop transcription`, `send`,
`delete backward`, `clear dictation`, `mute`, and `unmute` intents, and
absolute held-scroll state, plus replace-latest semantic control status with
bounded candidate progress. Every active action identifies the exact voice
request, and every event is scoped to
the random helper session. Reliable lifecycle, intent, and held-scroll events
share a strict monotonic sequence, while Desktop applies its bounded local
freshness policy before acting on received control.

The runtime consists of this Rust executable and two verified TFLite models
from the pinned Gesture Recognizer bundle. tract executes palm and hand-landmark
inference, then GSV's authored Rust recognizer maps landmark geometry into its
small pose vocabulary. Python, Java, Bazel, and MediaPipe native code are not
build or runtime dependencies.

## Build and run locally

From the repository root:

```bash
./scripts/vision-native/prepare.sh
cargo build --manifest-path host/Cargo.toml --package gestures
GSV_GESTURES=1 cargo run --manifest-path host/apps/desktop/Cargo.toml
```

On macOS, the first camera start requests access before enumerating devices.
For command-line development builds, macOS may attribute that request to the
launching terminal; grant that application camera access and rerun the command.
Denial fails with `camera permission was not granted` instead of attempting to
open a device without authorization. The default selection prefers the built-in
camera and opens it by its stable platform identifier. Capture requests a native
format explicitly and converts row-strided frames locally to packed RGB.

The matching versioned models are discovered automatically from
`host/target/vision-native/artifact/`. The headless mode above is the real local
control path. Use the diagnostic
window against the same pose recognizer with:

```bash
GSV_GESTURE_DEBUG=1 cargo run --manifest-path host/apps/desktop/Cargo.toml
```

The Desktop singleton starts one helper only after Desktop itself has won
startup. Close the diagnostic window or press `Escape` to stop debug mode; the
Desktop remains open. Closing Desktop terminates the helper process even when a
camera or inference call is stuck below Rust.

The debug window mirrors presentation, but inference always receives the
original camera frame. It draws up to two 21-point hand skeletons, handedness,
authored pose labels and confidence, a simple two-hand relationship, and
capture/inference/render timing. It also shows the semantic controller state:
DISABLED, STANDBY, TRANSCRIBING, or TRANSCRIBING + MUTED, the fixed-vocabulary
rejection, and clockwise progress through the complete temporal evidence gate.
The same bounded semantic state and quantized progress are sent to Desktop as
replace-latest presentation feedback; they cannot invoke an action. Raw labels,
scores, landmarks, and diagnostics remain inside the helper. Capture and
inference each retain only their latest value, so a slow machine drops stale
frames rather than accumulating a private video queue.

## Gesture grammar

The non-dominant hand is the modifier and the dominant hand performs actions;
camera array order is irrelevant. By default, the helper learns the roles when
it sees exactly one relaxed open/C-shaped `Anchor` hand. Set
`GSV_GESTURE_DOMINANT_HAND=left` or `right` to assign them explicitly. Desktop supplies one
strict absolute context: standby when there is no voice request and the helper
may propose starting one, disabled while an existing request is preparing,
stopping, or otherwise not gesture-eligible, or active with the exact listening
request and acknowledged mute state. Desktop still owns final Start admission
under transient UI policy. Keyboard-started dictation enters the same active
context; the helper has no separate persistent armed bit.

- Keep the modifier in `Anchor`: a relaxed open/C-shaped hand with the thumb
  comfortably separated from the fingers.
- Touch the dominant thumb and index fingertip, with the remaining fingers
  relaxed inward, for 350 ms. In standby this starts transcription; while
  active the same primary pinch stops it.
- Touch the dominant thumb and middle fingertip for 700 ms to send now.
- Make a loose dominant fist, with the thumb resting near the curled fingers,
  for 450 ms to mute or 700 ms to unmute, depending on current state.
- Point the dominant index above or below the modifier palm for 250 ms, then
  hold to scroll in that direction.
- With the dominant index level with the modifier palm, flick it left at least
  12% of the mirrored camera width within 500 ms to delete one visible Unicode
  character (grapheme) from the unsent voice-owned transcription. Relax the
  pointing hand between repeated deletes.
- Gather all dominant fingertips to the thumb and hold for 1 second to clear
  the unsent voice-owned transcription. Text typed before or after the voice
  insertion point and draft attachments remain intact.

Scroll gestures work in either standby or active voice mode. On a long moment,
holding scrolls only that moment and stops at its edge. A fresh gesture begun at
an edge moves exactly one moment; the held gesture is then consumed until a
different known pose is observed, so it cannot skip through multiple moments.
All other postures are unassigned.
Every gesture enters and continues at 0.50 confidence. After emitting any
intent, the helper blocks further commands until Desktop echoes a fresh
absolute context; an unchanged echo also resolves a rejected or nonterminal
request. The emitted pose stays latched across disabled, standby, active, and
request transitions until the helper positively observes a different known
two-hand pose at sufficient confidence. Missing, stale, invalid, or unknown
tracking cannot release this latch, so holding Start or Stop cannot loop after
an authority echo. Send, delete, and clear remain nonterminal and do not end
capture. Desktop first asks the transcription helper to finalize the exact
current segment; only the matching `SegmentFinal` may send or edit the draft,
so a later partial cannot resurrect corrected text.

Evidence also requires the gesture-specific dwell, match count, strong-sample
count, consecutive and support thresholds, fresh frames, and bounded inference
gaps. Progress is the minimum of those aggregate gates and remains below
complete until an intent is emitted. Missing or unrecognized classifications,
stale frames, real capture gaps, and tracking loss clear only in-flight
evidence; they never start or stop transcription or change mute state. Fresh
evidence must satisfy a complete dwell after any such loss. This grammar does
not infer speech silence or implement auto-send.

## Local overrides

- `GSV_VISION_CAMERA=1` selects a numeric camera from the current discovery
  order. Without an override, the built-in camera is preferred and the first
  discovered camera is the fallback.
- `GSV_VISION_NATIVE_MODELS=/path/to/gesture-recognizer-float16-1` overrides
  the extracted model root; every model is still verified by size and SHA-256.
- `GSV_GESTURE_DOMINANT_HAND=auto|left|right` selects the action hand. `auto`
  is the default and assigns roles from the first unambiguous modifier anchor.
- `GSV_VISION_HELPER=/path/to/gsv-vision` tells Desktop which helper executable
  to supervise.

An explicit missing override fails closed instead of silently falling back.
The model must always match the pinned size and SHA-256 before the camera opens.
Library/model/backend paths and native diagnostics are not printed.

The artifact and parity contract lives in
[`scripts/vision-native/README.md`](../../../scripts/vision-native/README.md).
The proof is not part of release packaging yet.
