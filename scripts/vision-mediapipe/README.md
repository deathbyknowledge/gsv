# Pinned local MediaPipe artifact

This directory defines the platform-scoped artifact boundary for GSV's optional
gesture-recognition helper. Runtime inference is local: camera frames are passed
only to an in-process MediaPipe C API loaded by the separately supervised
`gsv-vision` helper. The wrapper has no network or telemetry code and never
renders native diagnostics, which can contain private filesystem paths.

## Pinned inputs

- MediaPipe source release: `v1.0.0`
- Source commit: `6d31f1ebc3284db74d211d62bdc4f0a0c29ea120`
- Bazel: `7.4.1` (the source tree's `.bazelversion`)
- Hermetic Bazel Python: `3.12`
- Source patch SHA-256:
  `421610d4118bf8695a49c1e260aaef1da10740e769e5e49c4cc58c78b7a1dfe8`
- Bzlmod lock SHA-256:
  `e06eee9fa6c7d6cfa1274f21a4db530d92a9cfce082233d2818b04fcef77f73f`
- EasyEXIF commit: `cd994a3b6009bc3c1f84062e96bd7f5ad16e85f6`
- OpenCV release: `3.4.11`
- OpenCV peeled commit: `e8d4259f9ab787b512b9aa1203fc816fb9f19231`
- OpenCV source archive SHA-256:
  `29bc44d68525fe04513d06be57833aa0c1feab1c364bf5a96793b44212009a4d`
- OpenCV license SHA-256:
  `a5a7cf90fe5ac9763baad852cf69cf9d9b89bff934a679fdc5c8fcecaeba9a25`
- Official float16 Gesture Recognizer task SHA-256:
  `97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482`

The source is the official
[MediaPipe repository](https://github.com/google-ai-edge/mediapipe/tree/6d31f1ebc3284db74d211d62bdc4f0a0c29ea120).
The model is the artifact linked by the official
[Gesture Recognizer guide](https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer),
and its limitations are described in Google's
[gesture model card](https://storage.googleapis.com/mediapipe-assets/gesture_recognizer/model_card_hand_gesture_classification_with_faireness_2022.pdf).

## Build and artifact contract

Run the native builder for the host from any directory:

```bash
# Linux x86-64
./scripts/vision-mediapipe/build-linux.sh

# Apple Silicon macOS
./scripts/vision-mediapipe/build-macos.sh
```

Linux requires a C++ toolchain, CMake, Make, `git`, `curl`, `sha256sum`,
`unzip`, `readelf`, `patchelf`, and either `bazelisk` or Bazel 7.4.1. macOS
requires Apple Silicon, a complete Xcode installation selected with
`xcode-select`, CMake, Make, `git`, `curl`, `shasum`, and Bazelisk or Bazel
7.4.1. Neither builder uses Python or OpenCV from the host.

A typical macOS setup is:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
brew install bazelisk cmake
```

OpenCV is built from the pinned source archive and its exact versioned runtime
DSOs are included in the artifact; Python is not a runtime dependency.

The build deliberately defaults to two Bazel jobs, two local CPU resources,
2,048 MB of scheduled local RAM, and reduced process priority so it remains
usable on an interactive development machine. Dedicated builders may override
those limits with `GSV_MEDIAPIPE_JOBS`,
`GSV_MEDIAPIPE_LOCAL_CPU_RESOURCES`, and
`GSV_MEDIAPIPE_LOCAL_RAM_RESOURCES_MB`; each value must be a positive integer.
The pinned builders support Linux x86-64 and Apple Silicon macOS. Each has its
own artifact name, native dependency validation, and tested dependency closure.
Another architecture must add those things explicitly rather than relabeling
one of these artifacts.

Each builder serializes access to its work directory, ignores ambient system and
home Bazel configuration, removes the upstream user-rc imports, clears known
TensorFlow, CMake, pkg-config, and OpenCV source/toolchain override variables,
and requires the repo-owned Bzlmod lock in error mode. The source patch also
pins and verifies the otherwise floating EasyEXIF and OpenCV archives plus
MediaPipe's Abseil and Protobuf overrides. OpenCV's optional codecs, UI, video,
accelerator, Python, Java, and system-integration surfaces are disabled; only
shared `core` and `imgproc` are built, with OpenCV's bundled zlib selected.

The script stages a versioned directory below
`host/target/vision-mediapipe/artifact/` containing:

```text
BUILD-INFO
ARTIFACTS.sha256
runtime.json
ELF-NEEDED.txt or MACHO-NEEDED.txt
lib/libgesture_recognizer.{so,dylib}
lib/platform-native OpenCV core and imgproc libraries
model/gesture_recognizer.task
licenses/LICENSE
licenses/NOTICE
licenses/opencv-LICENSE
```

`BUILD-INFO` records the source patch, Bzlmod lock, Bazel/model contract,
native toolchain, and build switches. `runtime.json` is the machine-checked
contract: target platform, MediaPipe source and ABI, required C exports, model
identity, and the size and SHA-256 of every runtime payload. The helper verifies
it before opening the camera. `ELF-NEEDED.txt` or `MACHO-NEEDED.txt` is the
allowlist-review surface for native dependencies. `ARTIFACTS.sha256` also covers
the manifest for release tooling.

On Linux, the Bazel gesture output is first required to contain only `$ORIGIN`
and origin-relative Bazel `_solib` `DT_RUNPATH` entries—never an absolute or
other search path. The Linux script installs a staged copy and uses
`patchelf --force-rpath --set-rpath '$ORIGIN'` to replace those build-tree paths
with exactly `DT_RPATH=$ORIGIN`; it does not mutate the Bazel output. Using
`DT_RPATH` with no `DT_RUNPATH` is deliberate: glibc searches it before
`LD_LIBRARY_PATH`, so that environment variable cannot replace the pinned
adjacent OpenCV DSOs with ambient libraries sharing their SONAMEs. The OpenCV
DSOs remain byte-identical to their build outputs and have no `RPATH` or
`RUNPATH`. The script then
revalidates the staged architecture, SONAME, exact final RPATH with no RUNPATH,
complete `DT_NEEDED` allowlist, and seven C exports, and confirms relocation did
not change the original dependency or export sets. It requires the gesture
library to name both bundled versioned OpenCV DSOs directly and rejects Python,
path-bearing, unversioned OpenCV, or unexpected system dependencies.

On Apple Silicon, the builder uses MediaPipe's official Darwin shared-library
target, rewrites only the staged copies' install names, and requires the two
adjacent OpenCV libraries through `@loader_path`. It rejects non-system or
unexpected Mach-O dependencies and verifies the exact arm64 architecture and
seven C exports. Signing and application bundling are deliberately separate
release steps; this builder produces a local development runtime.

This OpenCV CPU converter is intentional. The palm detector asks the
image-to-tensor calculator for zero padding, and tracked hand regions can use
arbitrary rotation. MediaPipe v1.0.0's FrameBuffer converter rejects zero
padding and only implements rotations in 90-degree increments. Its OpenCV
converter implements constant-zero borders and arbitrary affine transforms, so
selecting `--define=OPENCV=source` fixes the behavior at MediaPipe's owning
converter boundary without changing the graph or model semantics.

The helper automatically discovers the matching development artifact or a
`vision-runtime` directory beside itself. `GSV_VISION_RUNTIME` selects another
complete verified runtime. The narrower `GSV_MEDIAPIPE_LIBRARY` and
`GSV_VISION_MODEL` overrides remain for deliberate local development, and
`GSV_VISION_CAMERA` selects the local camera. There are no command-line path
arguments and no network handshake.

Artifacts created before `runtime.json` was introduced are intentionally not
accepted. Move an old target artifact aside and rerun its builder; the script
will never silently replace a differing artifact directory.

This is a pinned, auditable build recipe, not yet a bit-for-bit reproducible
release environment: the host compiler, libc, linker, and `patchelf` remain
inputs. A release pipeline should run it in a digest-pinned Linux builder,
publish the generated hashes and dependency list, test under outbound-network
denial, and sign the resulting archive.

A cold build now compiles the small OpenCV `core` + `imgproc` closure in
addition to MediaPipe, so it uses more build time and cache space than the old
FrameBuffer path. Runtime remains CPU-only and local; the artifact adds two
versioned DSOs, with no Python process or host OpenCV installation.

## Runtime smoke

Each build script is the structural smoke: it fails before publishing unless
the patch, lock, C ABI, native metadata, dependency closure, licenses, and payload
hashes match the contract. The behavioral smoke still matters because it opens
the graph that originally failed: launch the Desktop vision debug view with the
new artifact, confirm camera and XNNPACK initialization completes without the
`BorderMode::kZero` FrameBuffer error, then rotate a detected hand away from
90-degree increments and confirm landmarks and live gesture labels continue to
update. Exercise one- and two-hand frames before treating the artifact as a
release candidate.

On macOS, build `gsv-vision` after the artifact and start Desktop from the same
terminal with `GSV_GESTURE_DEBUG=1`. The current command-line development build
may be attributed to the launching terminal for camera permission. A team-ready
signed `GSV.app` still needs its camera purpose string, entitlement, nested-code
signing, hardened runtime, and notarization; those are not claimed by this
artifact builder.

## Licensing and model-use gate

MediaPipe source is Apache-2.0. The staged `LICENSE` and aggregate `NOTICE` are
extracted from Google's pinned official wheel rather than synthesized. That
notice may be a superset of the gesture-only target's dependencies.

The pinned OpenCV source license is fetched from the exact peeled commit,
hash-verified, and staged separately as `licenses/opencv-LICENSE`.

The downloadable task bundle's model card describes intended use and
limitations, but does not state an explicit redistribution license for every
nested model. Treat the downloaded model as a local-development artifact. Do
not publish or bundle it in a GSV release until maintainers have recorded a
model-redistribution decision. In particular, the model card says surveillance,
identity recognition, sign-language translation, and life-critical decisions
are out of scope.
