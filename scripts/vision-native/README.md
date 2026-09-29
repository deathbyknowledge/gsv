# Native gesture models

`gsv-vision` owns camera capture, tracking, authored poses and temporal controls
in Rust. LiteRT 2.2.0's CPU interpreter executes its two TFLite models through an
explicit XNNPACK delegate. Model loading requires both graphs to be fully
delegated to XNNPACK.

## Build and distribution

The checksum-pinned models live in normal Git under
`host/helpers/gestures/models/` and are embedded in `gsv-vision`. Build from the
host workspace:

```bash
cd host
cargo build --package gestures
```

CMake 3.22+, a C++20 compiler and Git are required. The first build fetches
checksum-pinned LiteRT and TensorFlow source archives and their upstream
dependencies. Cargo's native build directory caches those sources and objects.
There is no model preparation step or Python, Java, Bazel or MediaPipe runtime.

The C++ bridge, CPU interpreter, XNNPACK and supporting libraries are combined
into a static archive and linked into the helper. Runtime needs only the
platform's normal system libraries. Release downloads remain Linux x64,
Linux ARM64, macOS Intel and macOS Apple Silicon. XNNPACK selects CPU kernels
at runtime; do not build distributable binaries with `-march=native` or
`-C target-cpu=native`. macOS helper builds default to the application's macOS
12.0 deployment baseline. Linux release builds use Ubuntu 22.04.

Each landmark interpreter owns reusable input/output buffers. Two hand workers
use separate interpreters and divide the CPU budget between them. Palm inference
runs in a separate, sequential stage with the full budget. Normal recognition
uses up to four inference threads in total; one-hand inference uses one landmark
interpreter's share. The same mutex protects an interpreter when called outside
the hand pool. No native pointer, model diagnostic or image data crosses IPC.

The build script verifies the models by size and SHA-256 before embedding them.
They add roughly 7.8 MB to the executable. Their Apache 2.0 license and exact
provenance live beside the weights. Native dependency notices are in
`host/helpers/gestures/THIRD_PARTY.md`; release assets, the host installer and
the macOS bundle carry those notices with the models' license and provenance.

Maintainers can deliberately update the vendored models with:

```bash
./scripts/vision-native/update-models.sh
```

That script downloads the official Gesture Recognizer float16 v1 bundle,
verifies its SHA-256, extracts the palm and hand-landmark detectors, and
verifies both outputs before replacing the checked-in files. Ordinary builds,
tests, benchmarks, and packages never invoke it. A runtime dependency update
also requires reviewing the native source pins and regenerating its notices.

## Validation

Ordinary gesture tests verify complete XNNPACK delegation, every model output
against a synthetic LiteRT reference at one, two and four threads, invalid
model/tensor rejection, and independent state under concurrent inference.
The executable test copies the helper to an empty installation directory and
checks its handshake and shutdown with a cleared environment, without opening
a camera. The existing Linux Desktop CI job runs these tests and public-image
parity. Release builds run both on Linux x64/ARM64 and macOS Intel/Apple Silicon.

Run the public-image parity tests with:

```bash
./scripts/vision-native/parity.sh
```

The script defaults to `--release --package gestures`; arguments replace that
Cargo selection. Linux Desktop CI passes the same test profile and package set
as its ordinary test command, so fixture checks reuse those compiled tests.
Matching only the profile is insufficient: a different package set can change
dependency features and rebuild the native runtime.

That job also caches native C/C++ compilation with ccache across tests, Clippy
and subsequent runs, with a 512 MB limit. It normalizes build paths and checks
compiler contents, source, headers and flags before reusing output. Cache
statistics follow the test and Clippy commands. Compiler-cache configuration
is applied after Rust dependency-cache restoration so adding the launcher does
not invalidate the existing Rust cache.

The tests download four checksum-pinned official fixture images and check handedness,
wrist coordinates, authored poses and actionability against the existing
MediaPipe Tasks reference. A composite frame also exercises two simultaneous
hands, tracking loss and reacquisition. MediaPipe supplies golden landmarks;
it is not installed or executed by these tests.

The synthetic model reference provenance and regeneration command are in
`host/helpers/gestures/native/testdata/README.md`. Those tests need no network
or Python after native build dependencies are cached.

## Benchmark

```bash
./scripts/vision-native/benchmark.sh
```

The benchmark warms the models, then measures full palm discovery, continuous
one-hand tracking, two known hand regions with tracking reuse, and fresh
two-hand landmark inference on every frame. The last scenario asserts two
landmark executions per sample, so cached observations cannot hide inference
cost. Image decoding and model loading are outside scenario intervals; model
initialization is measured separately after one warmup load. The first model
load in the benchmark process is recorded separately; it does not imply cold
operating-system page caches.

JSON output defaults to the ignored
`host/target/vision-native/benchmark/latest.json`; pass another path as the
first argument to retain a run. Schema 5 records the backend, total inference
budget, threads per landmark interpreter, and per-stage latency and execution
counts. Separate XNNPACK operator profiling retains the twenty hottest
operators without double-counting their enclosing delegate event. These
profilers are attached only by tests; production does not collect timings
inside the models.

For controlled experiments, `GSV_VISION_BENCHMARK_THREADS=1` (or another bounded
count) overrides the CPU budget in test builds. Keep CPU affinity, inputs and
sample counts matched when comparing results.

The [inference investigation](INFERENCE.md) records native measurements,
browser compatibility checks using the same model files, and speech
acceleration findings. Complete browser capture, tracking and speech pipelines
still need implementation and validation.
