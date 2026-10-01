#!/usr/bin/env bash
set -euo pipefail

readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$script_dir/../.." && pwd)"
fixtures="$($script_dir/fixtures.sh)"
if command -v cygpath >/dev/null 2>&1; then
  fixtures="$(cygpath -w "$fixtures")"
  # Git Bash puts its Unix link utility ahead of the MSVC linker.
  if [[ -n "${VCToolsInstallDir:-}" ]]; then
    export PATH="$(cygpath -u "$VCToolsInstallDir")/bin/Host${VSCMD_ARG_HOST_ARCH:-x64}/${VSCMD_ARG_TGT_ARCH:-x64}:$PATH"
  fi
fi
readonly fixtures

if [[ $# -eq 0 ]]; then
  set -- --release --package gestures
fi

GSV_VISION_PARITY_FIXTURES="$fixtures" \
  cargo test --locked --manifest-path "$repository_root/host/Cargo.toml" "$@" \
  matches_mediapipe -- --ignored
