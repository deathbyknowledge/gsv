#!/usr/bin/env bash
set -euo pipefail

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$script_dir/../.." && pwd)"
readonly fixtures="$($script_dir/fixtures.sh)"

if [[ $# -eq 0 ]]; then
  set -- --release --package gestures
fi

GSV_VISION_PARITY_FIXTURES="$fixtures" \
  cargo test --locked --manifest-path "$repository_root/host/Cargo.toml" "$@" \
  matches_mediapipe -- --ignored
