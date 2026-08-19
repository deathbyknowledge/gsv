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
readonly PATCH_SHA256="421610d4118bf8695a49c1e260aaef1da10740e769e5e49c4cc58c78b7a1dfe8"
readonly BZLMOD_LOCK_SHA256="e06eee9fa6c7d6cfa1274f21a4db530d92a9cfce082233d2818b04fcef77f73f"
readonly OPENCV_VERSION="3.4.11"
readonly OPENCV_COMMIT="e8d4259f9ab787b512b9aa1203fc816fb9f19231"
readonly OPENCV_ARCHIVE_SHA256="29bc44d68525fe04513d06be57833aa0c1feab1c364bf5a96793b44212009a4d"
readonly OPENCV_LICENSE_URL="https://raw.githubusercontent.com/opencv/opencv/${OPENCV_COMMIT}/LICENSE"
readonly OPENCV_LICENSE_SHA256="a5a7cf90fe5ac9763baad852cf69cf9d9b89bff934a679fdc5c8fcecaeba9a25"
readonly MODEL_URL="https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
readonly MODEL_SHA256="97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482"

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

require_no_untracked_source_files() {
  local checked_source_dir="$1"
  local report_path="$2"
  git -C "$checked_source_dir" ls-files --others --exclude-standard \
    | awk '$0 != "MODULE.bazel.lock" { print }' >"$report_path"
  [[ ! -s "$report_path" ]] || die "source cache has untracked files"
}

sha256_of() {
  sha256sum --binary "$1" | awk '{print $1}'
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
  mv -- "$temporary_download" "$destination"
}

validate_bazel_runpath() {
  local actual_runpath="$1"
  local description="$2"
  local origin='$ORIGIN'
  local origin_prefix='$ORIGIN/'
  local direct_solib_pattern='^(\.\./)+_solib_[[:alnum:]_]+/[^/].*$'
  local runfiles_solib_pattern='^libgesture_recognizer\.so\.runfiles/[^/]+/_solib_[[:alnum:]_]+/[^/].*$'
  local runpath_entry
  local relative_entry
  local saw_solib_entry=0
  local -a runpath_entries

  [[ -n "$actual_runpath" ]] || die "$description has no Bazel RUNPATH"
  [[ "$actual_runpath" != :* && "$actual_runpath" != *: && "$actual_runpath" != *::* ]] \
    || die "$description has an empty Bazel RUNPATH entry"
  IFS=: read -r -a runpath_entries <<<"$actual_runpath"
  for runpath_entry in "${runpath_entries[@]}"; do
    if [[ "$runpath_entry" == "$origin" ]]; then
      continue
    fi
    [[ "$runpath_entry" == "$origin_prefix"* ]] \
      || die "$description has a non-relative Bazel RUNPATH entry: $runpath_entry"
    relative_entry="${runpath_entry#"$origin_prefix"}"
    [[ -n "$relative_entry" && "$relative_entry" != /* ]] \
      || die "$description has an invalid Bazel RUNPATH entry: $runpath_entry"
    [[ "$relative_entry" != *//* && "$relative_entry" != *\\* ]] \
      || die "$description has a malformed Bazel RUNPATH entry: $runpath_entry"
    [[ "$relative_entry" != *'$'* && ! "$relative_entry" =~ [[:space:]] ]] \
      || die "$description has an unsafe Bazel RUNPATH entry: $runpath_entry"
    if [[ "$relative_entry" =~ $direct_solib_pattern ]] \
      || [[ "$relative_entry" =~ $runfiles_solib_pattern ]]; then
      saw_solib_entry=1
      continue
    fi
    die "$description has a non-_solib Bazel RUNPATH entry: $runpath_entry"
  done
  [[ "$saw_solib_entry" == 1 ]] \
    || die "$description RUNPATH contains no Bazel _solib entry"
}

validate_elf() {
  local binary="$1"
  local expected_soname="$2"
  local runtime_path_policy="$3"
  local description="$4"
  local elf_header="$temporary_dir/ELF-HEADER.txt"
  local elf_dynamic="$temporary_dir/ELF-DYNAMIC.txt"
  local actual_soname
  local actual_rpath
  local actual_runpath

  readelf --file-header "$binary" >"$elf_header"
  readelf --dynamic --wide "$binary" >"$elf_dynamic"
  grep --quiet 'Class:[[:space:]]*ELF64' "$elf_header" \
    || die "$description is not a 64-bit ELF artifact"
  grep --quiet 'Data:.*2.s complement, little endian' "$elf_header" \
    || die "$description is not little-endian"
  grep --quiet 'Machine:.*Advanced Micro Devices X86-64' "$elf_header" \
    || die "$description is not an x86-64 artifact"

  actual_soname="$(sed -n 's/.*(SONAME).*\[\([^]]*\)\].*/\1/p' "$elf_dynamic")"
  [[ "$actual_soname" == "$expected_soname" ]] \
    || die "$description SONAME is not $expected_soname"

  case "$runtime_path_policy" in
    bazel)
      if grep --quiet '(RPATH)' "$elf_dynamic"; then
        die "$description contains DT_RPATH instead of Bazel's RUNPATH"
      fi
      actual_runpath="$(sed -n 's/.*(RUNPATH).*\[\([^]]*\)\].*/\1/p' "$elf_dynamic")"
      validate_bazel_runpath "$actual_runpath" "$description"
      ;;
    origin_rpath)
      if grep --quiet '(RUNPATH)' "$elf_dynamic"; then
        die "$description contains DT_RUNPATH instead of the artifact RPATH"
      fi
      actual_rpath="$(sed -n 's/.*(RPATH).*\[\([^]]*\)\].*/\1/p' "$elf_dynamic")"
      [[ "$actual_rpath" == '$ORIGIN' ]] \
        || die "$description RPATH is not exactly \$ORIGIN"
      ;;
    none)
      if grep --quiet --extended-regexp '\((RPATH|RUNPATH)\)' "$elf_dynamic"; then
        die "$description contains a runtime search path"
      fi
      ;;
    *) die "internal error: unknown runtime path policy" ;;
  esac
}

extract_needed_libraries() {
  local binary="$1"
  local destination="$2"
  readelf --dynamic --wide "$binary" \
    | sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p' \
    | sort -u >"$destination"
}

validate_needed_libraries() {
  local needed_file="$1"
  local description="$2"
  local needed

  while IFS= read -r needed; do
    [[ -n "$needed" ]] || continue
    [[ "$needed" != */* ]] \
      || die "$description has a path-bearing DT_NEEDED entry"
    case "${needed,,}" in
      *python*) die "$description unexpectedly depends on Python" ;;
    esac
    case "$needed" in
      ld-linux-x86-64.so.2 | \
        libc.so.6 | \
        libdl.so.2 | \
        libgcc_s.so.1 | \
        libm.so.6 | \
        libopencv_core.so.3.4 | \
        libopencv_imgproc.so.3.4 | \
        libpthread.so.0 | \
        librt.so.1 | \
        libstdc++.so.6) ;;
      *) die "$description has an unexpected runtime dependency: $needed" ;;
    esac
  done <"$needed_file"
}

[[ "$(uname -s)" == "Linux" ]] || die "this script supports Linux only"

case "$(uname -m)" in
  x86_64 | amd64)
    readonly artifact_arch="x86_64"
    readonly notice_wheel_url="https://files.pythonhosted.org/packages/d3/1d/bc666b2edee87cc06421b040df0282607339091954ab9d4906a65a45be10/mediapipe-1.0.0-py3-none-manylinux_2_28_x86_64.whl"
    readonly notice_wheel_sha256="07a449446bf888a8a2787dbf6fc1a33da4c47977313deec64d13c35bff41f6d2"
    ;;
  *) die "this pinned artifact build supports Linux x86-64 only" ;;
esac

for command_name in awk c++ cmake cmp curl diff flock git grep install make mktemp nice nm patchelf readelf sed sha256sum sort stat tr unzip; do
  require_command "$command_name"
done

patchelf_identity="$(patchelf --version 2>&1 | sed -n '1p')"
[[ -n "$patchelf_identity" ]] || die "patchelf did not report its version"
readonly patchelf_identity

if command -v bazelisk >/dev/null 2>&1; then
  readonly bazel_command="$(command -v bazelisk)"
elif command -v bazel >/dev/null 2>&1; then
  readonly bazel_command="$(command -v bazel)"
else
  die "Bazelisk or Bazel $BAZEL_VERSION is required"
fi

readonly script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
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

work_dir="${GSV_MEDIAPIPE_WORK_DIR:-$repository_root/host/target/vision-mediapipe}"
[[ -n "$work_dir" ]] || die "work directory must not be empty"
mkdir -p -- "$work_dir"
readonly work_dir="$(CDPATH= cd -- "$work_dir" && pwd -P)"
exec 9>"$work_dir/.build.lock"
flock --nonblock 9 || die "another vision artifact build owns the work directory"
readonly source_dir="$work_dir/source"
readonly downloads_dir="$work_dir/downloads"
readonly artifact_parent="$work_dir/artifact"
readonly artifact_name="linux-${artifact_arch}-mediapipe-${MEDIAPIPE_VERSION}"
readonly artifact_dir="$artifact_parent/$artifact_name"

mkdir -p -- "$downloads_dir" "$artifact_parent"
temporary_dir="$(mktemp -d "$work_dir/.temporary.XXXXXX")"
readonly temporary_dir
bazel_server_started=0

shutdown_bazel() {
  [[ "$bazel_server_started" == 1 ]] || return 0
  if ! (CDPATH= cd -- "$source_dir" \
    && "$bazel_command" --nosystem_rc --nohome_rc shutdown 9>&-) >/dev/null 2>&1; then
    printf 'vision-mediapipe: warning: Bazel server did not shut down cleanly\n' >&2
  fi
  bazel_server_started=0
  return 0
}

cleanup() {
  shutdown_bazel || true
  case "$temporary_dir" in
    "$work_dir"/.temporary.*)
      rm -rf -- "$temporary_dir" \
        || printf 'vision-mediapipe: warning: temporary cleanup failed\n' >&2
      ;;
    *) printf 'vision-mediapipe: refusing unsafe temporary cleanup\n' >&2 ;;
  esac
  return 0
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
  mkdir -p -- "$source_dir"
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
cmp --silent "$patch_file" "$actual_patch" || die "source cache differs from pinned patch"

readonly source_bzlmod_lock="$source_dir/MODULE.bazel.lock"
if [[ -e "$source_bzlmod_lock" ]]; then
  [[ -f "$source_bzlmod_lock" && ! -L "$source_bzlmod_lock" ]] \
    || die "source Bzlmod lock is not a regular file"
  cmp --silent "$bzlmod_lock_file" "$source_bzlmod_lock" \
    || die "source Bzlmod lock differs from pinned lock"
else
  install -m 0644 "$bzlmod_lock_file" "$source_bzlmod_lock"
fi

readonly untracked_source_files="$temporary_dir/untracked-source-files.txt"
require_no_untracked_source_files "$source_dir" "$untracked_source_files"

[[ "$(tr -d '[:space:]' <"$source_dir/.bazelversion")" == "$BAZEL_VERSION" ]] \
  || die "source Bazel version mismatch"
readonly reported_bazel_version="$(CDPATH= cd -- "$source_dir" \
  && nice -n 10 "$bazel_command" --batch --nosystem_rc --nohome_rc version 9>&- \
    | sed -n 's/^Build label: //p')"
[[ "$reported_bazel_version" == "$BAZEL_VERSION" ]] \
  || die "Bazel $BAZEL_VERSION is required"

printf 'Verifying the pinned C ABI...\n'
c++ -std=c++17 -fsyntax-only -I "$source_dir" "$script_dir/verify-abi.cc"

printf 'Building the CPU-only gesture C library...\n'
bazel_server_started=1
(
  cd -- "$source_dir"
  nice -n 10 "$bazel_command" --nosystem_rc --nohome_rc build \
    --jobs="$bazel_jobs" \
    --local_cpu_resources="$bazel_local_cpu_resources" \
    --local_ram_resources="$bazel_local_ram_resources_mb" \
    --loading_phase_threads="$bazel_local_cpu_resources" \
    --lockfile_mode=error \
    --compilation_mode=opt \
    --strip=always \
    --linkopt=-s \
    --define=MEDIAPIPE_DISABLE_GPU=1 \
    --define=OPENCV=source \
    --repo_env="HERMETIC_PYTHON_VERSION=$HERMETIC_PYTHON_VERSION" \
    //mediapipe/tasks/c/vision/gesture_recognizer:libgesture_recognizer.so \
    9>&-
)
shutdown_bazel
cmp --silent "$bzlmod_lock_file" "$source_bzlmod_lock" \
  || die "Bazel changed the pinned Bzlmod lock"
require_no_untracked_source_files "$source_dir" "$untracked_source_files"

readonly built_library="$source_dir/bazel-bin/mediapipe/tasks/c/vision/gesture_recognizer/libgesture_recognizer.so"
readonly built_opencv_dir="$source_dir/bazel-bin/third_party/opencv_cmake/lib"
readonly built_opencv_core="$built_opencv_dir/libopencv_core.so.3.4"
readonly built_opencv_imgproc="$built_opencv_dir/libopencv_imgproc.so.3.4"
[[ -f "$built_library" ]] || die "Bazel did not produce the gesture library"
[[ -f "$built_opencv_core" ]] || die "Bazel did not produce the pinned OpenCV core DSO"
[[ -f "$built_opencv_imgproc" ]] || die "Bazel did not produce the pinned OpenCV imgproc DSO"

validate_elf "$built_library" libgesture_recognizer.so bazel "Bazel gesture library"
validate_elf "$built_opencv_core" libopencv_core.so.3.4 none "OpenCV core library"
validate_elf "$built_opencv_imgproc" libopencv_imgproc.so.3.4 none \
  "OpenCV imgproc library"

readonly model_cache="$downloads_dir/gesture_recognizer-float16-1.task"
readonly notice_wheel_cache="$downloads_dir/mediapipe-1.0.0-notice.whl"
readonly opencv_license_cache="$downloads_dir/opencv-${OPENCV_COMMIT}-LICENSE"
fetch_verified "$MODEL_URL" "$MODEL_SHA256" "$model_cache" "gesture model"
fetch_verified "$notice_wheel_url" "$notice_wheel_sha256" "$notice_wheel_cache" \
  "official license bundle"
fetch_verified "$OPENCV_LICENSE_URL" "$OPENCV_LICENSE_SHA256" \
  "$opencv_license_cache" "OpenCV license"

readonly license_file="$temporary_dir/LICENSE"
readonly notice_file="$temporary_dir/NOTICE"
unzip -p "$notice_wheel_cache" mediapipe-1.0.0.dist-info/licenses/LICENSE >"$license_file"
unzip -p "$notice_wheel_cache" mediapipe-1.0.0.dist-info/licenses/NOTICE >"$notice_file"
[[ -s "$license_file" && -s "$notice_file" ]] || die "official license bundle is incomplete"

readonly stage_dir="$temporary_dir/stage"
mkdir -p -- "$stage_dir/lib" "$stage_dir/model" "$stage_dir/licenses"
readonly staged_library="$stage_dir/lib/libgesture_recognizer.so"
readonly staged_opencv_core="$stage_dir/lib/libopencv_core.so.3.4"
readonly staged_opencv_imgproc="$stage_dir/lib/libopencv_imgproc.so.3.4"
install -m 0755 "$built_library" "$staged_library"
install -m 0755 "$built_opencv_core" "$staged_opencv_core"
install -m 0755 "$built_opencv_imgproc" "$staged_opencv_imgproc"
install -m 0644 "$model_cache" "$stage_dir/model/gesture_recognizer.task"
install -m 0644 "$license_file" "$stage_dir/licenses/LICENSE"
install -m 0644 "$notice_file" "$stage_dir/licenses/NOTICE"
install -m 0644 "$opencv_license_cache" "$stage_dir/licenses/opencv-LICENSE"

patchelf --force-rpath --set-rpath '$ORIGIN' "$staged_library"
if cmp --silent "$built_library" "$staged_library"; then
  die "patchelf did not relocate the staged gesture library"
fi
cmp --silent "$built_opencv_core" "$staged_opencv_core" \
  || die "staging changed the OpenCV core library"
cmp --silent "$built_opencv_imgproc" "$staged_opencv_imgproc" \
  || die "staging changed the OpenCV imgproc library"
validate_elf "$built_library" libgesture_recognizer.so bazel "Bazel gesture library"
validate_elf "$staged_library" libgesture_recognizer.so origin_rpath \
  "staged gesture library"
validate_elf "$staged_opencv_core" libopencv_core.so.3.4 none \
  "staged OpenCV core library"
validate_elf "$staged_opencv_imgproc" libopencv_imgproc.so.3.4 none \
  "staged OpenCV imgproc library"

readonly exported_symbols="$temporary_dir/exported-symbols.txt"
readonly built_exported_symbols="$temporary_dir/built-exported-symbols.txt"
nm --dynamic --defined-only "$staged_library" \
  | awk '{print $3}' | sort -u >"$exported_symbols"
nm --dynamic --defined-only "$built_library" \
  | awk '{print $3}' | sort -u >"$built_exported_symbols"
cmp --silent "$built_exported_symbols" "$exported_symbols" \
  || die "patchelf changed the gesture library exports"
for required_symbol in "${REQUIRED_SYMBOLS[@]}"; do
  grep --fixed-strings --line-regexp --quiet "$required_symbol" "$exported_symbols" \
    || die "staged gesture library is missing required C symbols"
done

readonly gesture_needed="$temporary_dir/gesture-needed.txt"
readonly built_gesture_needed="$temporary_dir/built-gesture-needed.txt"
readonly opencv_core_needed="$temporary_dir/opencv-core-needed.txt"
readonly opencv_imgproc_needed="$temporary_dir/opencv-imgproc-needed.txt"
extract_needed_libraries "$staged_library" "$gesture_needed"
extract_needed_libraries "$built_library" "$built_gesture_needed"
extract_needed_libraries "$staged_opencv_core" "$opencv_core_needed"
extract_needed_libraries "$staged_opencv_imgproc" "$opencv_imgproc_needed"
validate_needed_libraries "$gesture_needed" "staged gesture library"
validate_needed_libraries "$opencv_core_needed" "staged OpenCV core library"
validate_needed_libraries "$opencv_imgproc_needed" "staged OpenCV imgproc library"
cmp --silent "$built_gesture_needed" "$gesture_needed" \
  || die "patchelf changed the gesture library dependencies"
grep --fixed-strings --line-regexp --quiet libopencv_core.so.3.4 "$gesture_needed" \
  || die "staged gesture library does not directly depend on bundled OpenCV core"
grep --fixed-strings --line-regexp --quiet libopencv_imgproc.so.3.4 "$gesture_needed" \
  || die "staged gesture library does not directly depend on bundled OpenCV imgproc"
if grep --ignore-case --quiet opencv "$opencv_core_needed"; then
  die "staged OpenCV core library unexpectedly depends on another OpenCV DSO"
fi
grep --fixed-strings --line-regexp --quiet libopencv_core.so.3.4 "$opencv_imgproc_needed" \
  || die "staged OpenCV imgproc library does not depend on bundled OpenCV core"

{
  printf 'lib/libgesture_recognizer.so:\n'
  sed 's/^/  /' "$gesture_needed"
  printf '\nlib/libopencv_core.so.3.4:\n'
  sed 's/^/  /' "$opencv_core_needed"
  printf '\nlib/libopencv_imgproc.so.3.4:\n'
  sed 's/^/  /' "$opencv_imgproc_needed"
} >"$stage_dir/ELF-NEEDED.txt"

readonly compiler_identity="$(c++ --version | sed -n '1p')"
cat >"$stage_dir/BUILD-INFO" <<EOF
contract=1
platform=linux-${artifact_arch}
mediapipe_version=${MEDIAPIPE_VERSION}
mediapipe_commit=${MEDIAPIPE_COMMIT}
source_patch_sha256=${PATCH_SHA256}
bzlmod_lock_sha256=${BZLMOD_LOCK_SHA256}
bazel_version=${BAZEL_VERSION}
hermetic_python_version=${HERMETIC_PYTHON_VERSION}
compiler=${compiler_identity}
patchelf=${patchelf_identity}
build_flags=opt,strip-always,disable-gpu,opencv-source-core-imgproc,staged-origin-rpath-relocation,bzlmod-lock-error
opencv_version=${OPENCV_VERSION}
opencv_commit=${OPENCV_COMMIT}
opencv_archive_sha256=${OPENCV_ARCHIVE_SHA256}
opencv_license_sha256=${OPENCV_LICENSE_SHA256}
runtime_rpath=\$ORIGIN
model_variant=gesture_recognizer/float16/1
model_sha256=${MODEL_SHA256}
runtime_manifest_schema=1
abi_version=1
EOF

runtime_files=(
  BUILD-INFO
  ELF-NEEDED.txt
  lib/libgesture_recognizer.so
  lib/libopencv_core.so.3.4
  lib/libopencv_imgproc.so.3.4
  licenses/LICENSE
  licenses/NOTICE
  licenses/opencv-LICENSE
  model/gesture_recognizer.task
)
{
  printf '{\n'
  printf '  "schema": 1,\n'
  printf '  "platform": "linux-%s",\n' "$artifact_arch"
  printf '  "mediapipe_version": "%s",\n' "$MEDIAPIPE_VERSION"
  printf '  "mediapipe_commit": "%s",\n' "$MEDIAPIPE_COMMIT"
  printf '  "abi_version": 1,\n'
  printf '  "library": "lib/libgesture_recognizer.so",\n'
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
      "$(stat --format='%s' "$runtime_file")" \
      "$(sha256_of "$runtime_file")" \
      "$file_suffix"
  done
  printf '  ]\n'
  printf '}\n'
} >"$stage_dir/runtime.json"

(
  cd -- "$stage_dir"
  sha256sum \
    BUILD-INFO \
    ELF-NEEDED.txt \
    lib/libgesture_recognizer.so \
    lib/libopencv_core.so.3.4 \
    lib/libopencv_imgproc.so.3.4 \
    licenses/LICENSE \
    licenses/NOTICE \
    licenses/opencv-LICENSE \
    model/gesture_recognizer.task \
    runtime.json >ARTIFACTS.sha256
)

if [[ -e "$artifact_dir" ]]; then
  diff --recursive --brief "$stage_dir" "$artifact_dir" >/dev/null \
    || die "existing artifact differs; move it aside before rebuilding"
else
  mv --no-target-directory -- "$stage_dir" "$artifact_dir"
fi

printf 'MediaPipe artifact ready: %s\n' "$artifact_name"
