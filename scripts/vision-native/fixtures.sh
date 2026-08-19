#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'vision-native-fixtures: %s\n' "$1" >&2
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

fetch() {
  local name="$1"
  local sha="$2"
  local url="$3"
  local destination="$fixtures/$name"
  if [[ ! -f "$destination" ]] || [[ "$(sha256 "$destination")" != "$sha" ]]; then
    local temporary="$fixtures/.$name.$$"
    curl --fail --location --silent --show-error "$url" --output "$temporary"
    [[ "$(sha256 "$temporary")" == "$sha" ]] || die "$name failed checksum verification"
    mv "$temporary" "$destination"
  fi
}

command -v curl >/dev/null 2>&1 || die "curl is required"

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$script_dir/../.." && pwd)"
readonly fixtures="$repository_root/host/target/vision-native/parity"
mkdir -p "$fixtures"

fetch fist.jpg 43fa1cabf3f90d574accc9a56986e2ee48638ce59fc65af1846487f73bb2ef24 \
  'https://storage.googleapis.com/mediapipe-assets/tasks/testdata/vision/fist.jpg?generation=1782184710240231'
fetch pointing_up.jpg ecf8ca2611d08fa25948a4fc10710af9120e88243a54da6356bacea17ff3e36e \
  'https://storage.googleapis.com/mediapipe-assets/tasks/testdata/vision/pointing_up.jpg?generation=1782185079090086'
fetch thumb_up.jpg 5d673c081ab13b8a1812269ff57047066f9c33c07db5f4178089e8cb3fdc0291 \
  'https://storage.googleapis.com/mediapipe-assets/tasks/testdata/vision/thumb_up.jpg?generation=1782185354353621'
fetch victory.jpg 84cb8853e3df614e0cb5c93a25e3e2f38ea5e4f92fd428ee7d867ed3479d5764 \
  'https://storage.googleapis.com/mediapipe-assets/tasks/testdata/vision/victory.jpg?generation=1782185383577587'

printf '%s\n' "$fixtures"
