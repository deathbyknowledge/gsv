# Native gesture models

`gsv-vision` implements the complete gesture pipeline in Rust. tract executes
the two TFLite palm and hand-landmark models; GSV's authored pose recognizer
maps their geometry into the local control vocabulary. It does not build or
load MediaPipe, TensorFlow, Python, Java, or Bazel.

The checksum-pinned models live in normal Git under
`host/helpers/gestures/models/` and are embedded in `gsv-vision`. Build the
normal host workspace without a model preparation step or network access:

```bash
cd host
cargo build --workspace
```

The gesture crate's build script verifies both files by size and SHA-256 before
the compiler embeds them. They add roughly 7.8 MB to the helper and do not need
to be copied beside it at runtime. Their Apache 2.0 license and exact source,
bundle checksum, extracted checksums, and update procedure live beside the
weights.

Maintainers can reproduce or deliberately update the vendored files with:

```bash
./scripts/vision-native/update-models.sh
```

That script downloads the official Gesture Recognizer float16 v1 bundle,
verifies its SHA-256, extracts only the palm and hand-landmark detectors, and
verifies both outputs before replacing the checked-in files. Ordinary builds,
tests, benchmarks, and packages never invoke it.

Run the reference parity test with:

```bash
./scripts/vision-native/parity.sh
```

That test downloads four checksum-pinned official fixture images and checks the
Rust pipeline's handedness and wrist coordinates against the outputs of the same
landmark model through MediaPipe Tasks. It also verifies that authored fist and
sequential one- and two-finger poses remain actionable while a thumbs-up remains
unassigned. MediaPipe supplies the landmark golden reference only; it is not
installed or executed by the test.

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
The upstream TFLite graph is intentionally embedded because it
preserves this NHWC execution shape; alternative deployment formats must clear
the same parity, size, loading, and inference benchmarks before replacing it.
