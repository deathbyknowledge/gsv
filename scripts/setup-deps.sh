#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Error: cargo is required but was not found in PATH." >&2
  exit 1
fi

install_dir() {
  local dir="$1"
  echo ""
  echo "==> Installing dependencies in ${dir#$ROOT_DIR/}"
  (
    cd "$dir"
    bun install
  )
}

install_channels() {
  local channels_dir="$ROOT_DIR/channels"
  local found=0

  if [[ ! -d "$channels_dir" ]]; then
    echo ""
    echo "==> Skipping channels install (no channels/ directory found)"
    return
  fi

  for dir in "$channels_dir"/*; do
    [[ -d "$dir" ]] || continue
    [[ -f "$dir/package.json" ]] || continue
    found=1
    install_dir "$dir"
  done

  if [[ "$found" -eq 0 ]]; then
    echo ""
    echo "==> No channel packages found under channels/"
  fi
}

install_dir "$ROOT_DIR/gateway"
install_dir "$ROOT_DIR/gateway/ui"
install_channels

echo ""
echo "All JavaScript dependencies are installed."
echo ""
echo "Next:"
echo "  cd gateway"
echo "  bun alchemy/cli.ts wizard"
