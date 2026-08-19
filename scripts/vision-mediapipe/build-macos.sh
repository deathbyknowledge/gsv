#!/usr/bin/env bash
set -euo pipefail

unset \
  CMAKE_PREFIX_PATH \
  CMAKE_TOOLCHAIN_FILE \
  HERMETIC_CC_TOOLCHAIN \
  HERMETIC_CUDA_COMPUTE_CAPABILITIES \
  HERMETIC_CUDA_VERSION \
  HERMETIC_CUDNN_VERSION \
  HERMETIC_NVSHMEM_VERSION \
  HERMETIC_PYTHON_PREFIX \
  HERMETIC_PYTHON_SHA256 \
  HERMETIC_PYTHON_URL \
  HERMETIC_PYTHON_VERSION \
  HERMETIC_PYTHON_VERSION_KIND \
  HERMETIC_REQUIREMENTS_LOCK \
  MACOSX_DEPLOYMENT_TARGET \
  OpenCV_DIR \
  OPENCV_CMAKE_HOOKS_DIR \
  OPENCV_DOWNLOAD_PATH \
  PKG_CONFIG_LIBDIR \
  PKG_CONFIG_PATH \
  PKG_CONFIG_SYSROOT_DIR \
  TF_PYTHON_VERSION \
  TF_SYSTEM_LIBS

export LC_ALL=C
umask 022

readonly MEDIAPIPE_VERSION="1.0.0"
readonly MEDIAPIPE_COMMIT="6d31f1ebc3284db74d211d62bdc4f0a0c29ea120"
readonly MEDIAPIPE_REPOSITORY="https://github.com/google-ai-edge/mediapipe.git"
readonly BAZEL_VERSION="7.4.1"
readonly HERMETIC_PYTHON_VERSION="3.12"
readonly PATCH_SHA256="0880f63a81192c08807312a74c8e2613c7332e193cf097dbaece3e2d30c06c87"
readonly BZLMOD_LOCK_SHA256="e06eee9fa6c7d6cfa1274f21a4db530d92a9cfce082233d2818b04fcef77f73f"
readonly OPENCV_VERSION="3.4.11"
readonly OPENCV_COMMIT="e8d4259f9ab787b512b9aa1203fc816fb9f19231"
readonly OPENCV_ARCHIVE_SHA256="29bc44d68525fe04513d06be57833aa0c1feab1c364bf5a96793b44212009a4d"
readonly OPENCV_LICENSE_URL="https://raw.githubusercontent.com/opencv/opencv/${OPENCV_COMMIT}/LICENSE"
readonly OPENCV_LICENSE_SHA256="a5a7cf90fe5ac9763baad852cf69cf9d9b89bff934a679fdc5c8fcecaeba9a25"
readonly MODEL_URL="https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
readonly MODEL_SHA256="97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482"
readonly NOTICE_WHEEL_URL="https://files.pythonhosted.org/packages/d3/1d/bc666b2edee87cc06421b040df0282607339091954ab9d4906a65a45be10/mediapipe-1.0.0-py3-none-manylinux_2_28_x86_64.whl"
readonly NOTICE_WHEEL_SHA256="07a449446bf888a8a2787dbf6fc1a33da4c47977313deec64d13c35bff41f6d2"

readonly REQUIRED_SYMBOLS=(
  MpErrorFree
  MpGestureRecognizerClose
  MpGestureRecognizerCloseResult
  MpGestureRecognizerCreate
  MpGestureRecognizerRecognizeForVideo
  MpImageCreateFromUint8Data
  MpImageFree
)

die() {
  printf 'vision-mediapipe: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

require_positive_integer() {
  local variable_name="$1"
  local value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || die "$variable_name must be a positive integer"
}

sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  [[ "$(sha256_of "$file")" == "$expected" ]]
}

fetch_verified() {
  local url="$1"
  local expected="$2"
  local destination="$3"
  local description="$4"
  local temporary_download="$temporary_dir/download"

  if [[ -f "$destination" ]]; then
    verify_sha256 "$destination" "$expected" || die "cached $description hash mismatch"
    return
  fi

  printf 'Fetching pinned %s...\n' "$description"
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 \
    --silent --show-error --output "$temporary_download" "$url"
  verify_sha256 "$temporary_download" "$expected" || die "$description hash mismatch"
  mv "$temporary_download" "$destination"
}

require_no_untracked_source_files() {
  local checked_source_dir="$1"
  local report_path="$2"
  git -C "$checked_source_dir" ls-files --others --exclude-standard \
    | awk '$0 != "MODULE.bazel.lock" { print }' >"$report_path"
  [[ ! -s "$report_path" ]] || die "source cache has untracked files"
}

validate_macho() {
  local file_path="$1"
  local description="$2"
  file "$file_path" | grep -q 'Mach-O 64-bit dynamically linked shared library arm64' \
    || die "$description is not an arm64 Mach-O shared library"
  [[ "$(lipo -archs "$file_path")" == "arm64" ]] \
    || die "$description contains an unexpected architecture"
}

macho_id() {
  otool -D "$1" | sed -n '2p'
}

extract_dependencies() {
  local file_path="$1"
  local destination="$2"
  otool -L "$file_path" \
    | sed -n '3,$s/^[[:space:]]*\([^[:space:]]*\).*/\1/p' \
    | sort -u >"$destination"
}

dependency_named() {
  local file_path="$1"
  local basename="$2"
  local destination="$3"
  extract_dependencies "$file_path" "$destination"
  awk -v basename="$basename" '
    $0 == basename { print; next }
    length($0) > length(basename) && substr($0, length($0) - length(basename), 1) == "/" && substr($0, length($0) - length(basename) + 1) == basename { print }
  ' "$destination"
}

rewrite_dependency() {
  local file_path="$1"
  local basename="$2"
  local replacement="$3"
  local report_path="$temporary_dir/dependencies-to-rewrite.txt"
  local matches
  matches="$(dependency_named "$file_path" "$basename" "$report_path")"
  [[ -n "$matches" && "$matches" != *$'\n'* ]] \
    || die "$(basename "$file_path") does not have exactly one $basename dependency"
  install_name_tool -change "$matches" "$replacement" "$file_path"
}

validate_dependencies() {
  local needed_file="$1"
  local description="$2"
  local dependency
  while IFS= read -r dependency; do
    [[ -n "$dependency" ]] || continue
    case "$dependency" in
      @loader_path/libopencv_core.3.4.dylib | \
        @loader_path/libopencv_imgproc.3.4.dylib | \
        /usr/lib/* | \
        /System/Library/Frameworks/*) ;;
      *) die "$description has an unexpected runtime dependency: $dependency" ;;
    esac
  done <"$needed_file"
}

[[ "$(uname -s)" == "Darwin" ]] || die "this script supports macOS only"
[[ "$(uname -m)" == "arm64" ]] \
  || die "this pinned artifact build supports Apple Silicon only"

for command_name in awk basename c++ cmake cmp curl diff file git grep install install_name_tool lipo make mktemp mv nice nm otool sed shasum sort stat tr unzip xcodebuild xcrun; do
  require_command "$command_name"
done
xcodebuild -version >/dev/null 2>&1 \
  || die "a complete Xcode installation must be selected with xcode-select"
xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1 \
  || die "the selected Xcode installation does not provide the macOS SDK"

if command -v bazelisk >/dev/null 2>&1; then
  readonly bazel_command="$(command -v bazelisk)"
elif command -v bazel >/dev/null 2>&1; then
  readonly bazel_command="$(command -v bazel)"
else
  die "Bazelisk or Bazel $BAZEL_VERSION is required"
fi

readonly script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)"
readonly repository_root="$(CDPATH= cd -- "$script_dir/../.." && pwd -P)"
readonly patch_file="$script_dir/mediapipe-v1.0.0-shared-library.patch"
readonly bzlmod_lock_file="$script_dir/MODULE.bazel.lock"

bazel_jobs="${GSV_MEDIAPIPE_JOBS-2}"
bazel_local_cpu_resources="${GSV_MEDIAPIPE_LOCAL_CPU_RESOURCES-2}"
bazel_local_ram_resources_mb="${GSV_MEDIAPIPE_LOCAL_RAM_RESOURCES_MB-2048}"
require_positive_integer GSV_MEDIAPIPE_JOBS "$bazel_jobs"
require_positive_integer GSV_MEDIAPIPE_LOCAL_CPU_RESOURCES "$bazel_local_cpu_resources"
require_positive_integer GSV_MEDIAPIPE_LOCAL_RAM_RESOURCES_MB "$bazel_local_ram_resources_mb"
readonly bazel_jobs bazel_local_cpu_resources bazel_local_ram_resources_mb

work_dir="${GSV_MEDIAPIPE_WORK_DIR:-$repository_root/target/vision-mediapipe}"
[[ -n "$work_dir" ]] || die "work directory must not be empty"
mkdir -p "$work_dir"
readonly work_dir="$(CDPATH= cd -- "$work_dir" && pwd -P)"
readonly lock_dir="$work_dir/.build-macos-arm64.lock"
mkdir "$lock_dir" 2>/dev/null || die "another vision artifact build owns the work directory"
readonly source_dir="$work_dir/source"
readonly downloads_dir="$work_dir/downloads"
readonly artifact_parent="$work_dir/artifact"
readonly artifact_name="macos-aarch64-mediapipe-${MEDIAPIPE_VERSION}"
readonly artifact_dir="$artifact_parent/$artifact_name"

mkdir -p "$downloads_dir" "$artifact_parent"
temporary_dir="$(mktemp -d "$work_dir/.temporary.XXXXXX")"
readonly temporary_dir
bazel_server_started=0

shutdown_bazel() {
  [[ "$bazel_server_started" == 1 ]] || return 0
  if ! (CDPATH= cd -- "$source_dir" \
    && "$bazel_command" --nosystem_rc --nohome_rc shutdown) >/dev/null 2>&1; then
    printf 'vision-mediapipe: warning: Bazel server did not shut down cleanly\n' >&2
  fi
  bazel_server_started=0
}

cleanup() {
  shutdown_bazel || true
  case "$temporary_dir" in
    "$work_dir"/.temporary.*) rm -rf "$temporary_dir" ;;
    *) printf 'vision-mediapipe: refusing unsafe temporary cleanup\n' >&2 ;;
  esac
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

verify_sha256 "$patch_file" "$PATCH_SHA256" || die "source patch hash mismatch"
verify_sha256 "$bzlmod_lock_file" "$BZLMOD_LOCK_SHA256" \
  || die "Bzlmod lock hash mismatch"

if [[ ! -e "$source_dir" ]]; then
  printf 'Fetching pinned MediaPipe source...\n'
  mkdir -p "$source_dir"
  git -C "$source_dir" init --quiet
  git -C "$source_dir" remote add origin "$MEDIAPIPE_REPOSITORY"
  git -C "$source_dir" fetch --quiet --depth=1 --no-tags origin "$MEDIAPIPE_COMMIT"
  git -C "$source_dir" checkout --quiet --detach FETCH_HEAD
elif [[ ! -d "$source_dir/.git" ]]; then
  die "existing source cache is not a Git checkout"
fi

readonly checked_out_commit="$(git -C "$source_dir" rev-parse HEAD 2>/dev/null)"
[[ "$checked_out_commit" == "$MEDIAPIPE_COMMIT" ]] || die "source cache commit mismatch"
git -C "$source_dir" diff --cached --quiet || die "source cache has staged changes"

readonly actual_patch="$temporary_dir/source.patch"
git -C "$source_dir" diff --no-ext-diff --binary >"$actual_patch"
if [[ ! -s "$actual_patch" ]]; then
  git -C "$source_dir" apply --check "$patch_file"
  git -C "$source_dir" apply "$patch_file"
  git -C "$source_dir" diff --no-ext-diff --binary >"$actual_patch"
fi
cmp -s "$patch_file" "$actual_patch" || die "source cache differs from pinned patch"

readonly source_bzlmod_lock="$source_dir/MODULE.bazel.lock"
if [[ -e "$source_bzlmod_lock" ]]; then
  [[ -f "$source_bzlmod_lock" && ! -L "$source_bzlmod_lock" ]] \
    || die "source Bzlmod lock is not a regular file"
  cmp -s "$bzlmod_lock_file" "$source_bzlmod_lock" \
    || die "source Bzlmod lock differs from pinned lock"
else
  install -m 0644 "$bzlmod_lock_file" "$source_bzlmod_lock"
fi

readonly untracked_source_files="$temporary_dir/untracked-source-files.txt"
require_no_untracked_source_files "$source_dir" "$untracked_source_files"
[[ "$(tr -d '[:space:]' <"$source_dir/.bazelversion")" == "$BAZEL_VERSION" ]] \
  || die "source Bazel version mismatch"
readonly reported_bazel_version="$(CDPATH= cd -- "$source_dir" \
  && nice -n 10 "$bazel_command" --batch --nosystem_rc --nohome_rc version \
    | sed -n 's/^Build label: //p')"
[[ "$reported_bazel_version" == "$BAZEL_VERSION" ]] \
  || die "Bazel $BAZEL_VERSION is required"

printf 'Verifying the pinned C ABI...\n'
c++ -std=c++17 -fsyntax-only -I "$source_dir" "$script_dir/verify-abi.cc"

printf 'Building the CPU-only Apple Silicon gesture C library...\n'
bazel_server_started=1
(
  cd -- "$source_dir"
  nice -n 10 "$bazel_command" --nosystem_rc --nohome_rc build \
    --config=darwin_arm64 \
    --jobs="$bazel_jobs" \
    --local_cpu_resources="$bazel_local_cpu_resources" \
    --local_ram_resources="$bazel_local_ram_resources_mb" \
    --loading_phase_threads="$bazel_local_cpu_resources" \
    --lockfile_mode=error \
    --compilation_mode=opt \
    --strip=always \
    --linkopt=-Wl,-headerpad_max_install_names \
    --define=MEDIAPIPE_DISABLE_GPU=1 \
    --define=OPENCV=source \
    --repo_env="HERMETIC_PYTHON_VERSION=$HERMETIC_PYTHON_VERSION" \
    //mediapipe/tasks/c/vision/gesture_recognizer:libgesture_recognizer.dylib
)
shutdown_bazel
cmp -s "$bzlmod_lock_file" "$source_bzlmod_lock" \
  || die "Bazel changed the pinned Bzlmod lock"
require_no_untracked_source_files "$source_dir" "$untracked_source_files"

readonly built_library="$source_dir/bazel-bin/mediapipe/tasks/c/vision/gesture_recognizer/libgesture_recognizer.dylib"
readonly built_opencv_dir="$source_dir/bazel-bin/third_party/opencv_cmake/lib"
readonly built_opencv_core="$built_opencv_dir/libopencv_core.3.4.dylib"
readonly built_opencv_imgproc="$built_opencv_dir/libopencv_imgproc.3.4.dylib"
[[ -f "$built_library" ]] || die "Bazel did not produce the gesture library"
[[ -f "$built_opencv_core" ]] || die "Bazel did not produce the pinned OpenCV core dylib"
[[ -f "$built_opencv_imgproc" ]] || die "Bazel did not produce the pinned OpenCV imgproc dylib"
validate_macho "$built_library" "Bazel gesture library"
validate_macho "$built_opencv_core" "OpenCV core library"
validate_macho "$built_opencv_imgproc" "OpenCV imgproc library"

readonly model_cache="$downloads_dir/gesture_recognizer-float16-1.task"
readonly notice_wheel_cache="$downloads_dir/mediapipe-1.0.0-notice.whl"
readonly opencv_license_cache="$downloads_dir/opencv-${OPENCV_COMMIT}-LICENSE"
fetch_verified "$MODEL_URL" "$MODEL_SHA256" "$model_cache" "gesture model"
fetch_verified "$NOTICE_WHEEL_URL" "$NOTICE_WHEEL_SHA256" "$notice_wheel_cache" \
  "official license bundle"
fetch_verified "$OPENCV_LICENSE_URL" "$OPENCV_LICENSE_SHA256" \
  "$opencv_license_cache" "OpenCV license"

readonly license_file="$temporary_dir/LICENSE"
readonly notice_file="$temporary_dir/NOTICE"
unzip -p "$notice_wheel_cache" mediapipe-1.0.0.dist-info/licenses/LICENSE >"$license_file"
unzip -p "$notice_wheel_cache" mediapipe-1.0.0.dist-info/licenses/NOTICE >"$notice_file"
[[ -s "$license_file" && -s "$notice_file" ]] || die "official license bundle is incomplete"

readonly stage_dir="$temporary_dir/stage"
mkdir -p "$stage_dir/lib" "$stage_dir/model" "$stage_dir/licenses"
readonly staged_library="$stage_dir/lib/libgesture_recognizer.dylib"
readonly staged_opencv_core="$stage_dir/lib/libopencv_core.3.4.dylib"
readonly staged_opencv_imgproc="$stage_dir/lib/libopencv_imgproc.3.4.dylib"
install -m 0755 "$built_library" "$staged_library"
install -m 0755 "$built_opencv_core" "$staged_opencv_core"
install -m 0755 "$built_opencv_imgproc" "$staged_opencv_imgproc"
install -m 0644 "$model_cache" "$stage_dir/model/gesture_recognizer.task"
install -m 0644 "$license_file" "$stage_dir/licenses/LICENSE"
install -m 0644 "$notice_file" "$stage_dir/licenses/NOTICE"
install -m 0644 "$opencv_license_cache" "$stage_dir/licenses/opencv-LICENSE"

install_name_tool -id '@rpath/libgesture_recognizer.dylib' "$staged_library"
install_name_tool -id '@rpath/libopencv_core.3.4.dylib' "$staged_opencv_core"
install_name_tool -id '@rpath/libopencv_imgproc.3.4.dylib' "$staged_opencv_imgproc"
rewrite_dependency "$staged_library" libopencv_core.3.4.dylib \
  '@loader_path/libopencv_core.3.4.dylib'
rewrite_dependency "$staged_library" libopencv_imgproc.3.4.dylib \
  '@loader_path/libopencv_imgproc.3.4.dylib'
rewrite_dependency "$staged_opencv_imgproc" libopencv_core.3.4.dylib \
  '@loader_path/libopencv_core.3.4.dylib'

[[ "$(macho_id "$staged_library")" == "@rpath/libgesture_recognizer.dylib" ]] \
  || die "staged gesture library has an unexpected install name"
[[ "$(macho_id "$staged_opencv_core")" == "@rpath/libopencv_core.3.4.dylib" ]] \
  || die "staged OpenCV core has an unexpected install name"
[[ "$(macho_id "$staged_opencv_imgproc")" == "@rpath/libopencv_imgproc.3.4.dylib" ]] \
  || die "staged OpenCV imgproc has an unexpected install name"

validate_macho "$staged_library" "staged gesture library"
validate_macho "$staged_opencv_core" "staged OpenCV core library"
validate_macho "$staged_opencv_imgproc" "staged OpenCV imgproc library"

readonly exported_symbols="$temporary_dir/exported-symbols.txt"
nm -gjU "$staged_library" 2>/dev/null | sed 's/^_//' | sort -u >"$exported_symbols"
for required_symbol in "${REQUIRED_SYMBOLS[@]}"; do
  grep -Fqx "$required_symbol" "$exported_symbols" \
    || die "staged gesture library is missing required C symbol: $required_symbol"
done

readonly gesture_needed="$temporary_dir/gesture-needed.txt"
readonly opencv_core_needed="$temporary_dir/opencv-core-needed.txt"
readonly opencv_imgproc_needed="$temporary_dir/opencv-imgproc-needed.txt"
extract_dependencies "$staged_library" "$gesture_needed"
extract_dependencies "$staged_opencv_core" "$opencv_core_needed"
extract_dependencies "$staged_opencv_imgproc" "$opencv_imgproc_needed"
validate_dependencies "$gesture_needed" "staged gesture library"
validate_dependencies "$opencv_core_needed" "staged OpenCV core library"
validate_dependencies "$opencv_imgproc_needed" "staged OpenCV imgproc library"
grep -Fqx '@loader_path/libopencv_core.3.4.dylib' \
  "$gesture_needed" || die "staged gesture library does not use bundled OpenCV core"
grep -Fqx '@loader_path/libopencv_imgproc.3.4.dylib' \
  "$gesture_needed" || die "staged gesture library does not use bundled OpenCV imgproc"
grep -Fqx '@loader_path/libopencv_core.3.4.dylib' \
  "$opencv_imgproc_needed" || die "staged OpenCV imgproc does not use bundled OpenCV core"
if grep -iq opencv "$opencv_core_needed"; then
  die "staged OpenCV core unexpectedly depends on another OpenCV dylib"
fi

{
  printf 'lib/libgesture_recognizer.dylib:\n'
  sed 's/^/  /' "$gesture_needed"
  printf '\nlib/libopencv_core.3.4.dylib:\n'
  sed 's/^/  /' "$opencv_core_needed"
  printf '\nlib/libopencv_imgproc.3.4.dylib:\n'
  sed 's/^/  /' "$opencv_imgproc_needed"
} >"$stage_dir/MACHO-NEEDED.txt"

readonly compiler_identity="$(c++ --version | sed -n '1p')"
readonly xcode_identity="$(xcodebuild -version | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
readonly macos_sdk="$(xcrun --sdk macosx --show-sdk-version)"
cat >"$stage_dir/BUILD-INFO" <<EOF
contract=1
platform=macos-aarch64
mediapipe_version=${MEDIAPIPE_VERSION}
mediapipe_commit=${MEDIAPIPE_COMMIT}
source_patch_sha256=${PATCH_SHA256}
bzlmod_lock_sha256=${BZLMOD_LOCK_SHA256}
bazel_version=${BAZEL_VERSION}
hermetic_python_version=${HERMETIC_PYTHON_VERSION}
compiler=${compiler_identity}
xcode=${xcode_identity}
macos_sdk=${macos_sdk}
build_flags=opt,strip-always,disable-gpu,opencv-source-core-imgproc,darwin-arm64,loader-path-relocation,bzlmod-lock-error
opencv_version=${OPENCV_VERSION}
opencv_commit=${OPENCV_COMMIT}
opencv_archive_sha256=${OPENCV_ARCHIVE_SHA256}
opencv_license_sha256=${OPENCV_LICENSE_SHA256}
runtime_dependency_path=@loader_path
model_variant=gesture_recognizer/float16/1
model_sha256=${MODEL_SHA256}
runtime_manifest_schema=1
abi_version=1
EOF

runtime_files=(
  BUILD-INFO
  MACHO-NEEDED.txt
  lib/libgesture_recognizer.dylib
  lib/libopencv_core.3.4.dylib
  lib/libopencv_imgproc.3.4.dylib
  licenses/LICENSE
  licenses/NOTICE
  licenses/opencv-LICENSE
  model/gesture_recognizer.task
)
{
  printf '{\n'
  printf '  "schema": 1,\n'
  printf '  "platform": "macos-aarch64",\n'
  printf '  "mediapipe_version": "%s",\n' "$MEDIAPIPE_VERSION"
  printf '  "mediapipe_commit": "%s",\n' "$MEDIAPIPE_COMMIT"
  printf '  "abi_version": 1,\n'
  printf '  "library": "lib/libgesture_recognizer.dylib",\n'
  printf '  "required_symbols": [\n'
  for symbol_index in "${!REQUIRED_SYMBOLS[@]}"; do
    symbol_suffix=,
    if [[ "$symbol_index" == "$((${#REQUIRED_SYMBOLS[@]} - 1))" ]]; then
      symbol_suffix=
    fi
    printf '    "%s"%s\n' "${REQUIRED_SYMBOLS[$symbol_index]}" "$symbol_suffix"
  done
  printf '  ],\n'
  printf '  "model": {\n'
  printf '    "path": "model/gesture_recognizer.task",\n'
  printf '    "bytes": 8373440,\n'
  printf '    "sha256": "%s"\n' "$MODEL_SHA256"
  printf '  },\n'
  printf '  "files": [\n'
  for file_index in "${!runtime_files[@]}"; do
    relative_path="${runtime_files[$file_index]}"
    runtime_file="$stage_dir/$relative_path"
    file_suffix=,
    if [[ "$file_index" == "$((${#runtime_files[@]} - 1))" ]]; then
      file_suffix=
    fi
    printf '    {"path":"%s","bytes":%s,"sha256":"%s"}%s\n' \
      "$relative_path" \
      "$(stat -f '%z' "$runtime_file")" \
      "$(sha256_of "$runtime_file")" \
      "$file_suffix"
  done
  printf '  ]\n'
  printf '}\n'
} >"$stage_dir/runtime.json"

(
  cd -- "$stage_dir"
  shasum -a 256 \
    BUILD-INFO \
    MACHO-NEEDED.txt \
    lib/libgesture_recognizer.dylib \
    lib/libopencv_core.3.4.dylib \
    lib/libopencv_imgproc.3.4.dylib \
    licenses/LICENSE \
    licenses/NOTICE \
    licenses/opencv-LICENSE \
    model/gesture_recognizer.task \
    runtime.json >ARTIFACTS.sha256
)

if [[ -e "$artifact_dir" ]]; then
  diff -qr "$stage_dir" "$artifact_dir" >/dev/null \
    || die "existing artifact differs; move it aside before rebuilding"
else
  mv "$stage_dir" "$artifact_dir"
fi

printf 'MediaPipe artifact ready: %s\n' "$artifact_name"
