#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Error: cargo is required but was not found in PATH." >&2
  exit 1
fi

echo ""
echo "==> Installing workspace dependencies"
(
  cd "$ROOT_DIR"
  bun install
)

echo ""
echo "All JavaScript dependencies are installed."
echo ""
echo "Next:"
echo "  bun run dev"
