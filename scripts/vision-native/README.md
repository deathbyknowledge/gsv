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
file. Intermediate nested task archives are discarded, so the final artifact
contains one checksum and the four runtime models only. The artifact stays under
ignored `host/target/vision-native/`; it is not checked into Git.

Run the reference parity test with:

```bash
./scripts/vision-native/parity.sh
```

That test downloads four checksum-pinned official fixture images and compares
the Rust pipeline's gesture, confidence, handedness, and wrist coordinates with
the outputs of the same model bundle through MediaPipe Tasks. MediaPipe is the
golden reference only; it is not installed or executed by the test.

Measure the optimized native pipeline with:

```bash
./scripts/vision-native/benchmark.sh
```

The benchmark warms the models, then measures full palm discovery, continuous
one-hand tracking, and processing two known hand regions over checksum-pinned
images. It reports overall throughput plus per-stage minimum, median, p95,
maximum, mean latency, and execution count. The machine-readable JSON is
written to the ignored `host/target/vision-native/benchmark/latest.json`; pass
another path as the first argument to retain named runs. Image decoding, model
loading, and report serialization are outside the scenario intervals. Model
initialization is measured separately after one warmup load.
The report also profiles the optimized Tract graphs for the palm and landmark
models, grouping time by operation and retaining the twenty hottest graph
nodes. Operator profiling runs after the scenario measurements so its timers do
not distort the pipeline results.
Production recognition uses a compile-time no-op profiler, so stage measurement
adds no runtime timers to normal builds.

Native inference uses up to four worker threads. For controlled benchmark
experiments only, `GSV_VISION_BENCHMARK_THREADS=1` (or another bounded count)
overrides that selection and is recorded in the report.

Eligible float32 NHWC depthwise convolutions use the native channel-SIMD
kernel; all other operations remain in tract. The report records the selected
depthwise kernel. Set `GSV_VISION_BENCHMARK_DEPTHWISE=tract` when running the
benchmark to produce a stock-tract comparison without changing production.
The upstream TFLite graph is intentionally retained at runtime because it
preserves this NHWC execution shape; alternative deployment formats must clear
the same parity, size, loading, and inference benchmarks before replacing it.

For a manually assembled distribution, put the extracted artifact beside
`gsv-vision` as `vision-models/` (including its `model/` child), or set
`GSV_VISION_NATIVE_MODELS` to the artifact root. Runtime loading always verifies
all four files before opening the camera.
