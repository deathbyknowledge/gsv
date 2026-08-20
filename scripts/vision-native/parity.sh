#!/usr/bin/env bash
set -euo pipefail

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$script_dir/../.." && pwd)"
readonly fixtures="$($script_dir/fixtures.sh)"

GSV_VISION_PARITY_FIXTURES="$fixtures" \
  cargo test --manifest-path "$repository_root/host/Cargo.toml" --package gestures \
  native::tests::matches_mediapipe_landmark_fixtures -- --ignored --exact
