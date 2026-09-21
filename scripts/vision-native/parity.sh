#!/usr/bin/env bash
set -euo pipefail

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$script_dir/../.." && pwd)"
readonly fixtures="$($script_dir/fixtures.sh)"

GSV_VISION_PARITY_FIXTURES="$fixtures" \
  cargo test --release --locked --manifest-path "$repository_root/host/Cargo.toml" --package gestures \
  matches_mediapipe -- --ignored
