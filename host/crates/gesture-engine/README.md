# Gesture engine

`gesture-engine` is the platform-neutral hand-control runtime used by GSV. It
contains packed-RGB hand tracking through tract and TFLite, authored landmark
pose recognition, and deterministic temporal gesture policy. It owns no camera,
window, operating-system permission, IPC transport, or application action.

Platform integrations provide frames and decide what emitted semantic events
mean. A desktop process can use a webcam and a private pipe; Android can use
CameraX and JNI; another project can supply its own tracker or policy through
the `HandTracker` and `GesturePolicy` traits.

The included voice-control policy is only one vocabulary. Applications remain
the authority for arming, request identity, text submission, microphone state,
and every other side effect.

## Boundaries

- `observation` contains packed RGB frames, landmarks, handedness, and the
  closed local pose vocabulary.
- `vision` contains the stateful tract tracker and accepts model bytes through
  `ModelData`; the crate does not choose a filesystem or asset-packaging policy.
- `control` contains deterministic, allocation-free temporal recognition and a
  ready-made `VoiceControlPolicy<RequestId>` with generic request identity.
- `HandTracker`, `GesturePolicy`, and `GesturePipeline` are the composition
  boundary for alternative inference backends and entirely different gesture
  vocabularies.

The `tract` feature is enabled by default. Consumers that already receive hand
observations, or only want the pose and policy layers, can use
`default-features = false` and avoid all inference dependencies.

```rust
use gesture_engine::{GesturePipeline, GesturePolicy};
use gesture_engine::observation::{FrameView, Observation};
use gesture_engine::vision::{ModelData, TractHandTracker};

struct MyPolicy;

impl GesturePolicy for MyPolicy {
    type Output = bool;

    fn update(&mut self, _frame: &FrameView, observation: &Observation) -> bool {
        !observation.hands.is_empty()
    }
}

let models = ModelData::new(palm_model_bytes, landmark_model_bytes);
let tracker = TractHandTracker::load(&models)?;
let mut pipeline = GesturePipeline::new(tracker, MyPolicy);
let output = pipeline.process(&frame, monotonic_timestamp_ms)?;
```

Frames, landmarks, and model outputs stay inside the embedding process unless
that application explicitly chooses otherwise. The engine emits data and
semantic proposals; it never opens a camera, sends IPC, or executes an action.

## Publication status

The package includes crate metadata but remains `publish = false` while it is
incubated in the GSV workspace. Before a crates.io release, the workspace-local
tract TFLite importer patch must be upstreamed or replaced, and the model
redistribution story must be documented for consumers. Neither issue affects
desktop or Android reuse from this workspace.
