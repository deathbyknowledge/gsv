#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PDS_DIR="${GSV_PDS_DIR:-$ROOT_DIR/pds}"
PDS_CONFIG="$PDS_DIR/wrangler.toml"
PERSIST_ROOT="${GSV_DEV_PERSIST_TO:-$ROOT_DIR/.wrangler/dev-state}"
STATE_ROOT="$PERSIST_ROOT/v3"
IP="${GSV_DEV_IP:-0.0.0.0}"

PORT_ARGS=()
if [[ -n "${GSV_DEV_PORT:-}" ]]; then
  PORT_ARGS+=(--port "$GSV_DEV_PORT")
fi

if [[ ! -f "$PDS_CONFIG" ]]; then
  echo "PDS worker config not found at $PDS_CONFIG" >&2
  echo "Set GSV_PDS_DIR to an alternate pds repo path if needed." >&2
  exit 1
fi

export PDS_WORKER_ROOT="$PDS_DIR"

mkdir -p "$STATE_ROOT/do/ripgit-Repository"
mkdir -p "$STATE_ROOT/do/gsv-Kernel"
mkdir -p "$STATE_ROOT/do/gsv-Process"
mkdir -p "$STATE_ROOT/do/gsv-channel-whatsapp-WhatsAppAccount"
mkdir -p "$STATE_ROOT/do/gsv-pds-RepoObject"
mkdir -p "$STATE_ROOT/do/gsv-pds-PdsDirectoryObject"

cd "$ROOT_DIR/ripgit"
exec npm exec -- wrangler dev \
  -c ../gateway/wrangler.jsonc \
  -c "$PDS_CONFIG" \
  -c ../assembler/wrangler.toml \
  -c ../adapters/whatsapp/wrangler.jsonc \
  -c wrangler.toml \
  --ip "$IP" \
  --persist-to "$PERSIST_ROOT" \
  "${PORT_ARGS[@]}"
