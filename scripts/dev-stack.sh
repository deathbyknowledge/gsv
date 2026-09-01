#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_STATE_DIR="${GSV_DEV_STATE_DIR:-$ROOT_DIR/.wrangler/dev-state}"
STATE_ROOT="$DEV_STATE_DIR/v3"

mkdir -p "$STATE_ROOT/do/ripgit-Repository"
mkdir -p "$STATE_ROOT/do/gsv-Kernel"
mkdir -p "$STATE_ROOT/do/gsv-Process"

ADAPTER_CONFIG_ARGS=()
ADAPTER_CATALOG_ROWS="$(node "$ROOT_DIR/scripts/adapter-catalog.mjs")"
while IFS= read -r row; do
  IFS=$'\t' read -r _adapter_id _display_name _component source_dir wrangler_config dev_state <<< "$row"
  ADAPTER_CONFIG_ARGS+=(-c "../../${source_dir}/${wrangler_config}")
  if [[ -n "$dev_state" ]]; then
    IFS=',' read -ra state_directories <<< "$dev_state"
    for state_directory in "${state_directories[@]}"; do
      mkdir -p "$STATE_ROOT/do/$state_directory"
    done
  fi
done <<< "$ADAPTER_CATALOG_ROWS"

cd "$ROOT_DIR/workers/ripgit"
exec npm exec -- wrangler dev \
  -c ../gateway/wrangler.jsonc \
  "${ADAPTER_CONFIG_ARGS[@]}" \
  -c wrangler.toml \
  --ip 0.0.0.0 \
  --persist-to "$DEV_STATE_DIR"
