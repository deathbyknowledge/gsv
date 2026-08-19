#!/usr/bin/env bash
set -euo pipefail

readonly BUNDLE_URL="https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
readonly BUNDLE_SHA256="97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482"
readonly ARTIFACT_NAME="gesture-recognizer-float16-1"

die() {
  printf 'vision-native: %s\n' "$1" >&2
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
  [[ -f "$path" ]] || die "missing extracted model $(basename "$path")"
  [[ "$(wc -c < "$path" | tr -d '[:space:]')" == "$expected_bytes" ]] \
    || die "unexpected size for $(basename "$path")"
  [[ "$(sha256 "$path")" == "$expected_sha" ]] \
    || die "unexpected checksum for $(basename "$path")"
}

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v unzip >/dev/null 2>&1 || die "unzip is required"

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$script_dir/../.." && pwd)"
readonly work_root="${GSV_VISION_NATIVE_WORK_DIR:-$repository_root/host/target/vision-native}"
readonly downloads_dir="$work_root/downloads"
readonly artifact_root="$work_root/artifact/$ARTIFACT_NAME"
readonly bundle="$downloads_dir/gesture_recognizer.task"

mkdir -p "$downloads_dir" "$(dirname "$artifact_root")"
if [[ ! -f "$bundle" ]] || [[ "$(sha256 "$bundle")" != "$BUNDLE_SHA256" ]]; then
  readonly bundle_tmp="$downloads_dir/.gesture_recognizer.task.$$"
  trap 'rm -f "${bundle_tmp:-}"' EXIT
  printf 'Fetching pinned gesture models...\n'
  curl --fail --location --silent --show-error "$BUNDLE_URL" --output "$bundle_tmp"
  [[ "$(sha256 "$bundle_tmp")" == "$BUNDLE_SHA256" ]] \
    || die "downloaded gesture bundle failed checksum verification"
  mv "$bundle_tmp" "$bundle"
  trap - EXIT
fi

readonly stage="$(mktemp -d "${TMPDIR:-/tmp}/gsv-vision-native.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/model"

unzip -p "$bundle" hand_landmarker.task > "$stage/hand_landmarker.task"
unzip -p "$bundle" hand_gesture_recognizer.task > "$stage/hand_gesture_recognizer.task"
unzip -p "$stage/hand_landmarker.task" hand_detector.tflite \
  > "$stage/model/hand_detector.tflite"
unzip -p "$stage/hand_landmarker.task" hand_landmarks_detector.tflite \
  > "$stage/model/hand_landmarks_detector.tflite"
unzip -p "$stage/hand_gesture_recognizer.task" gesture_embedder.tflite \
  > "$stage/model/gesture_embedder.tflite"
unzip -p "$stage/hand_gesture_recognizer.task" canned_gesture_classifier.tflite \
  > "$stage/model/canned_gesture_classifier.tflite"

verify_file "$stage/model/hand_detector.tflite" 2339878 \
  60d1bf8d70a80aba35b36290bb2a0e52e784ca2e524937d49ea80e8161a8a384
verify_file "$stage/model/hand_landmarks_detector.tflite" 5478949 \
  6acda74af3fbf40e68265c20c7394b2bad81a16a481dcd79ad7a081887c3d6b9
verify_file "$stage/model/gesture_embedder.tflite" 546000 \
  54abe78de1d1cd5e3cdaa0dab01db18e3ec7e09a76e7c3b5fa278572f7a60977
verify_file "$stage/model/canned_gesture_classifier.tflite" 7773 \
  62a87ded76da05155f6a59c8babb4c537c138c25138b29450fb030e207a5c0e9

printf '%s\n' "$BUNDLE_SHA256" > "$stage/bundle.sha256"
rm -rf "$artifact_root"
mv "$stage" "$artifact_root"
trap - EXIT
printf 'Native gesture models are ready at %s\n' "$artifact_root"
