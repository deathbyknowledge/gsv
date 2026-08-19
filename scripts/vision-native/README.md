# Native gesture models

`gsv-vision` implements the complete gesture pipeline in Rust and executes the
four TFLite models with tract. It does not build or load MediaPipe, TensorFlow,
Python, Java, or Bazel.

Prepare the checksum-pinned models once, then build the normal host workspace:

```bash
./scripts/vision-native/prepare.sh
cd host
cargo build --workspace
```

The preparation script downloads the official Gesture Recognizer float16 v1
bundle, verifies its SHA-256, extracts only the palm detector, hand landmark
detector, gesture embedder, and canned classifier, and verifies every extracted
file. The artifact stays under ignored `host/target/vision-native/`; it is not
checked into Git.

Run the reference parity test with:

```bash
./scripts/vision-native/parity.sh
```

That test downloads four checksum-pinned official fixture images and compares
the Rust pipeline's gesture, confidence, handedness, and wrist coordinates with
the outputs of the same model bundle through MediaPipe Tasks. MediaPipe is the
golden reference only; it is not installed or executed by the test.

For a manually assembled distribution, put the extracted artifact beside
`gsv-vision` as `vision-models/` (including its `model/` child), or set
`GSV_VISION_NATIVE_MODELS` to the artifact root. Runtime loading always verifies
all four files before opening the camera.
