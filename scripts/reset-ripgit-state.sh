#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_ROOT="$ROOT_DIR/.wrangler/dev-state/v3"
RIPGIT_DO_DIR="$STATE_ROOT/do/ripgit-Repository"

if [[ ! -d "$RIPGIT_DO_DIR" ]]; then
  mkdir -p "$RIPGIT_DO_DIR"
  echo "Initialized empty ripgit local state at ${RIPGIT_DO_DIR#$ROOT_DIR/}"
  exit 0
fi

rm -rf "$RIPGIT_DO_DIR"
mkdir -p "$RIPGIT_DO_DIR"
echo "Deleted ripgit local state at ${RIPGIT_DO_DIR#$ROOT_DIR/}"
