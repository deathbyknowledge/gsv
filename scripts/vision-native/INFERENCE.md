# Local inference investigation

Decision, 9 September 2026: pursue LiteRT/XNNPACK for native gesture inference
and LiteRT.js for browser inference using the same checked-in TFLite models.
The custom AOT compiler experiment has been retired. The native gesture helper
now uses a statically linked LiteRT 2.2.0 CPU interpreter with an explicit
XNNPACK delegate. The model files and authored gesture policy are unchanged.

Model execution belongs behind the gesture helper's model interface. Capture,
tracking, authored pose decisions, and temporal controls retain their existing
owners. A browser implementation should put inference in a Web Worker and
preserve the same decisions and cancellation boundaries. The gateway remains
the control plane.

## Native helper integration

The [integration measurements](native-results.json) compare the previous tract
helper at `75b839d1` with the replacement on the same Ryzen 9 5900X Linux
desktop, pinned to logical CPUs 0-3. Each scenario has six warmups and 30
measured frames using the existing public fixtures. This measures the helper's
recognition pipeline, excluding capture and display latency.

| Operation | Previous median / p95 | LiteRT median / p95 |
| --- | ---: | ---: |
| Full palm discovery and recognition | 36.21 / 39.20 ms | 9.37 / 10.72 ms |
| Continuous one-hand tracking | 10.50 / 12.40 ms | 5.10 / 5.99 ms |
| Two known hands with tracking reuse | 1.35 / 12.66 ms | 1.27 / 5.68 ms |
| Fresh inference for both hands | Not previously measured | 5.71 / 6.44 ms |
| Model loading after warmup | 77.27 / 79.34 ms | 12.57 / 12.75 ms |

Full-frame processing improved about fourfold. An initial run measured
8.73 ms median; both runs are retained to show live-desktop variation. The
first model load in the final benchmark process took 29.68 ms, separately from
the warmed loads; operating-system page caches were not flushed. The Linux
release executable shrank from 22,803,800 to 16,229,104 bytes, about 29%.

The four-thread budget gives palm inference four threads and each of two
independent landmark interpreters two threads. One-hand inference uses one
interpreter's share. The report records that distinction. A one-thread run
also passed all scenario assertions: full-frame recognition took 17.78 ms
median and fresh inference for both hands took 16.58 ms.

Validation passed on Linux x64: all gesture/protocol tests, every output from
both models against pinned synthetic LiteRT references at one/two/four
threads, public-fixture parity, two-hand tracking loss and recovery,
concurrent state isolation, a relocated helper with an empty environment,
formatting, Clippy and the installer smoke flow. An ASan/UBSan-instrumented
C++ bridge passed creation, concurrent inference, profiling, invalid lengths
and destruction; the upstream native archives were not instrumented.

The binary needs no separate inference library or model files. Its dynamic
dependencies are normal Linux system libraries. A cached release rebuild also
passed with Cargo offline and unreachable HTTP/HTTPS proxies. First builds
require CMake 3.22+, a C++20 compiler, Git and native dependency downloads.
CI and release tests cover Linux x64/ARM64 and macOS Intel/Apple Silicon;
the other architectures and macOS were not executed on this machine.

## Earlier native model comparison

The [recorded measurements](inference-results.json) were collected on an AMD
Ryzen 9 5900X / NVIDIA RTX 3090 Linux desktop at repository revision
`68a1d80393ef19817367fbeb646c869f306957ab`. This was a live desktop, so the
results are a comparison on this machine rather than release performance claims.

Native model benchmarks used logical CPUs 0-3, four distinct physical cores,
the same seed-42 FP32 input, ten warmups, and 100 measured invocations. Input
and output copies are included; camera capture, preprocessing, and temporal
gesture policy are excluded.

| Landmark implementation | Threads | Median / p95 |
| --- | ---: | ---: |
| Previous GSV tract | 4 | 9.47 / 10.88 ms |
| LiteRT/XNNPACK | 1 | 6.47 / 6.88 ms |
| LiteRT/XNNPACK | 2 | 3.36 / 3.71 ms |
| LiteRT/XNNPACK | 4 | 1.80 / 2.08 ms |

Here LiteRT 2.2.0 was measured through its Python API; the previous tract model
modules were exercised in a Rust harness. These isolated model measurements
are distinct from the native helper integration above.

Keep native downloads per supported OS/architecture with an explicit CPU and
OS baseline. [XNNPACK](https://github.com/google/XNNPACK) supplies optimized
kernels and CPU feature selection inside each build. A CPU model does not
need its own download link.

### Reproduce the LiteRT landmark comparison

Run from the repository root with Python 3.11+:

```bash
litert_root="$PWD/host/target/vision-native/litert"
python3 -m venv "$litert_root/python"
"$litert_root/python/bin/pip" install -r scripts/vision-native/litert-requirements.txt
taskset -c 0-3 "$litert_root/python/bin/python" \
  scripts/vision-native/litert-reference.py "$litert_root/corpus" --benchmark
```

`taskset` is Linux-specific; select an appropriate affinity on other systems
and record it when comparing results. The script generates five synthetic
inputs and native LiteRT output references, then reports one-, two-, and
four-thread measurements in `corpus/xnnpack.json`. It also processes any
additional `*.input.f32` crops in that directory with shape `[1, 224, 224, 3]`.
The recorded run included four public-fixture crops, for nine reference cases.
Omit `--benchmark` to generate references only. Production builds do not use
these Python dependencies.

## Browser feasibility

Both checked-in models ran without conversion in Chromium 151 on Linux using
`@litertjs/core` 2.5.3 with single-threaded WebAssembly and relaxed SIMD.
Their combined weight size is 7,818,827 bytes, about 7.8 MB.

The palm model passed comparison with native LiteRT on one synthetic input.
The landmark model passed on five synthetic inputs and four public-fixture
crops. All model outputs were checked: palm outputs and image landmarks allow
0.002 absolute difference, while presence, handedness, and world landmarks
allow 0.00002. The maximum observed differences were 0.00003815 for palms and
4.66e-10 across landmark outputs. No camera or microphone was opened.

The browser check did not use cross-origin isolation or WASM threads. Its
diagnostic timings include allocations and JS array conversion, use different
benchmark inputs from the native timing run, and are not a matched native/web
performance comparison. No WebGPU device was available in the headless session,
so GPU execution remains unverified. The disposable page, runner, and raw
results are under `host/target/inference-investigation/web-feasibility/`.

[LiteRT.js](https://github.com/google-ai-edge/LiteRT/blob/main/litert/js/packages/core/README.md)
provides XNNPACK CPU inference through WebAssembly and a WebGPU backend.
Browser assets can be shared across CPU architectures; runtime feature support
selects the appropriate backend. Before adoption, validate capture,
preprocessing, tracking, authored gestures, worker cancellation, and UI
responsiveness on the supported browsers and devices.

## Voice findings

The existing `transcribe-cpp` / `transcribe-cpp-sys` 0.2.2 engine was built with
Vulkan in an isolated harness. The same binary ran the pinned Nemotron 3.5
Streaming 0.6B Q5_K_M model with right-context 3, automatic language, and four
CPU workers on the public 11-second JFK sample. Each configuration had one
warmup and three measured utterances, fed without real-time pacing.

| Backend / feed size | Compute for 11 s audio | Finalize median | Feed p95 |
| --- | ---: | ---: | ---: |
| CPU / current 80 ms | 2.309 s | 86.95 ms | 60.07 ms |
| Vulkan / current 80 ms | 0.976 s | 23.89 ms | 22.94 ms |
| CPU / 320 ms | 1.918 s | 84.63 ms | 59.99 ms |
| Vulkan / 320 ms | 0.710 s | 24.43 ms | 24.67 ms |

Vulkan reduced compute 2.37x at the current feed size. All measured final
transcripts had the same hash. First text appeared after feeding 1,280 ms of
this clip on both backends; the compute reduction is not a demonstrated
reduction in microphone-to-text latency. CPU model loading took about 357 ms
and Vulkan loading 755 ms. Model, input, and dependency hashes are retained in
the measurement file; the isolated source and Cargo lockfile remain under
`host/target/inference-investigation/voice-vulkan/`.

Keep the existing native speech engine and evaluate its supported GPU backend.
Reduced encoder cost exposes redundant mel extraction as a larger fraction of
work. Preserve the helper's 80 ms control opportunities when optimizing feature
extraction; increasing feed size can delay partial text.

Browser speech needs separate validation. An
[INT4 ONNX export](https://huggingface.co/onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4)
and a [WebGPU/WASM implementation](https://github.com/FluidInference/fluidaudio-web)
exist for the same base Nemotron 3.5 model. Their weight packaging, quantization,
language selection, and streaming behavior differ from our 534 MiB GGUF path.
Speech was not executed in a browser during this investigation. Download/cache
behavior, memory, multilingual accuracy, partial latency, mute/cancel/segment
boundaries, power use, and simultaneous gesture work remain to be validated.
