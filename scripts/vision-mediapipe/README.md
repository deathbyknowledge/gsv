# Pinned local MediaPipe artifact

This directory defines the Linux-first artifact boundary for GSV's optional
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
  `6d5040fe7698bb983c1766e851efe12298467f6adf8cd0d3c922fc17fd0368e8`
- Bzlmod lock SHA-256:
  `0197909a04fbfd5b765d0a2e402496885ec1a6cc850f76fa34dfa454dc94563f`
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

Run `./scripts/vision-mediapipe/build-linux.sh` from any directory. It requires
a C++ toolchain, CMake, Make, `git`, `curl`, `sha256sum`, `unzip`, `readelf`,
`patchelf`, and either `bazelisk` or Bazel 7.4.1. It does not use Python or
OpenCV from the host.

OpenCV is built from the pinned source archive and its exact versioned runtime
DSOs are included in the artifact; Python is not a runtime dependency.

The build deliberately defaults to two Bazel jobs, two local CPU resources,
2,048 MB of scheduled local RAM, and reduced process priority so it remains
usable on an interactive development machine. Dedicated builders may override
those limits with `GSV_MEDIAPIPE_JOBS`,
`GSV_MEDIAPIPE_LOCAL_CPU_RESOURCES`, and
`GSV_MEDIAPIPE_LOCAL_RAM_RESOURCES_MB`; each value must be a positive integer.
This pinned PoC builder supports Linux x86-64 only. Another architecture needs
its own artifact name, ELF validation, builder image, and tested dependency
closure rather than reusing this artifact contract.

The script serializes access to its work directory, ignores ambient system and
home Bazel configuration, removes the upstream user-rc imports, clears known
TensorFlow, CMake, pkg-config, and OpenCV source/toolchain override variables,
and requires the repo-owned Bzlmod lock in error mode. The source patch also
pins and verifies the otherwise floating EasyEXIF and OpenCV archives plus
MediaPipe's Abseil and Protobuf overrides. OpenCV's optional codecs, UI, video,
accelerator, Python, Java, and system-integration surfaces are disabled; only
shared `core` and `imgproc` are built, with OpenCV's bundled zlib selected.

The script stages a versioned directory below
`target/vision-mediapipe/artifact/` containing:

```text
BUILD-INFO
ARTIFACTS.sha256
ELF-NEEDED.txt
lib/libgesture_recognizer.so
lib/libopencv_core.so.3.4
lib/libopencv_imgproc.so.3.4
model/gesture_recognizer.task
licenses/LICENSE
licenses/NOTICE
licenses/opencv-LICENSE
```

`BUILD-INFO` records the source patch, Bzlmod lock, Bazel/model contract,
`patchelf` version, and build switches.
`ELF-NEEDED.txt` is the allowlist-review surface for runtime shared-library
dependencies. `ARTIFACTS.sha256` covers every staged payload except itself.
The Bazel gesture output is first required to contain only `$ORIGIN` and
origin-relative Bazel `_solib` `DT_RUNPATH` entries—never an absolute or other
search path. The script installs a staged copy and uses
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

This OpenCV CPU converter is intentional. The palm detector asks the
image-to-tensor calculator for zero padding, and tracked hand regions can use
arbitrary rotation. MediaPipe v1.0.0's FrameBuffer converter rejects zero
padding and only implements rotations in 90-degree increments. Its OpenCV
converter implements constant-zero borders and arbitrary affine transforms, so
selecting `--define=OPENCV=source` fixes the behavior at MediaPipe's owning
converter boundary without changing the graph or model semantics.

The desktop supervisor passes the selected artifact to the helper through its
existing allowlisted `GSV_MEDIAPIPE_LIBRARY` and `GSV_VISION_MODEL` environment
variables. `GSV_VISION_CAMERA` selects the local camera. There are no command
line path arguments and no network handshake.

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

The build script is the structural smoke: it fails before publishing unless
the patch, lock, C ABI, ELF metadata, dependency closure, licenses, and payload
hashes match the contract. The behavioral smoke still matters because it opens
the graph that originally failed: launch the Desktop vision debug view with the
new artifact, confirm camera and XNNPACK initialization completes without the
`BorderMode::kZero` FrameBuffer error, then rotate a detected hand away from
90-degree increments and confirm landmarks and live gesture labels continue to
update. Exercise one- and two-hand frames before treating the artifact as a
release candidate.

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
