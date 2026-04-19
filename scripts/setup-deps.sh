#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but was not found in PATH." >&2
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
  npm install
)

echo ""
echo "==> Installing adapter dependencies"
for dir in "$ROOT_DIR"/adapters/*; do
  if [[ -f "$dir/package.json" ]]; then
    npm ci --prefix "$dir" --workspaces=false
  fi
done

echo ""
echo "==> Installing ripgit test dependencies"
(
  cd "$ROOT_DIR/ripgit"
  npm ci --workspaces=false
)

echo ""
echo "All JavaScript dependencies are installed."
echo ""
echo "Next:"
echo "  npm run dev"
