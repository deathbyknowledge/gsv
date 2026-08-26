#!/usr/bin/env bash
set -euo pipefail

readonly BUNDLE_URL="https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
readonly BUNDLE_SHA256="97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482"

die() {
  printf 'vision-native-models: %s\n' "$1" >&2
  exit 1
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

verify_file() {
  local path="$1"
  local expected_bytes="$2"
  local expected_sha="$3"
  local actual_bytes
  [[ -f "$path" ]] || die "missing extracted model $(basename "$path")"
  actual_bytes="$(wc -c < "$path" | tr -d '[:space:]')"
  [[ "$actual_bytes" == "$expected_bytes" ]] \
    || die "unexpected size for $(basename "$path"): expected $expected_bytes, got $actual_bytes"
  [[ "$(sha256 "$path")" == "$expected_sha" ]] \
    || die "unexpected checksum for $(basename "$path")"
}

for command in curl install unzip; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$script_dir/../.." && pwd)"
readonly work_root="${GSV_VISION_NATIVE_WORK_DIR:-$repository_root/host/target/vision-native}"
readonly downloads_dir="$work_root/downloads"
readonly model_root="$repository_root/host/helpers/gestures/models"
readonly bundle="$downloads_dir/gesture_recognizer.task"

mkdir -p "$downloads_dir" "$model_root"
if [[ ! -f "$bundle" ]] || [[ "$(sha256 "$bundle")" != "$BUNDLE_SHA256" ]]; then
  bundle_tmp="$downloads_dir/.gesture_recognizer.task.$$"
  trap 'rm -f "${bundle_tmp:-}"' EXIT
  printf 'Fetching pinned gesture models...\n'
  curl --fail --location --silent --show-error "$BUNDLE_URL" --output "$bundle_tmp"
  [[ "$(sha256 "$bundle_tmp")" == "$BUNDLE_SHA256" ]] \
    || die "downloaded gesture bundle failed checksum verification"
  mv "$bundle_tmp" "$bundle"
  trap - EXIT
fi

stage="$(mktemp -d "${TMPDIR:-/tmp}/gsv-vision-native.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
unzip -p "$bundle" hand_landmarker.task > "$stage/hand_landmarker.task"
unzip -p "$stage/hand_landmarker.task" hand_detector.tflite \
  > "$stage/hand_detector.tflite"
unzip -p "$stage/hand_landmarker.task" hand_landmarks_detector.tflite \
  > "$stage/hand_landmarks_detector.tflite"

verify_file "$stage/hand_detector.tflite" 2339878 \
  60d1bf8d70a80aba35b36290bb2a0e52e784ca2e524937d49ea80e8161a8a384
verify_file "$stage/hand_landmarks_detector.tflite" 5478949 \
  6acda74af3fbf40e68265c20c7394b2bad81a16a481dcd79ad7a081887c3d6b9
install -m 0644 "$stage/hand_detector.tflite" "$model_root/hand_detector.tflite"
install -m 0644 "$stage/hand_landmarks_detector.tflite" \
  "$model_root/hand_landmarks_detector.tflite"
printf 'Updated vendored gesture models in %s\n' "$model_root"
