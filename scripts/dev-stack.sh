#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PERSIST_ROOT="${GSV_DEV_PERSIST_TO:-$ROOT_DIR/.wrangler/dev-state}"
STATE_ROOT="$PERSIST_ROOT/v3"
IP="${GSV_DEV_IP:-0.0.0.0}"

PORT_ARGS=()
if [[ -n "${GSV_DEV_PORT:-}" ]]; then
  PORT_ARGS+=(--port "$GSV_DEV_PORT")
fi

mkdir -p "$STATE_ROOT/do/ripgit-Repository"
mkdir -p "$STATE_ROOT/do/gsv-Kernel"
mkdir -p "$STATE_ROOT/do/gsv-Process"
mkdir -p "$STATE_ROOT/do/gsv-channel-whatsapp-WhatsAppAccount"

cd "$ROOT_DIR/ripgit"
exec npm exec -- wrangler dev \
  -c ../gateway/wrangler.jsonc \
  -c ../assembler/wrangler.toml \
  -c ../adapters/whatsapp/wrangler.jsonc \
  -c wrangler.toml \
  --ip "$IP" \
  --persist-to "$PERSIST_ROOT" \
  "${PORT_ARGS[@]}"
