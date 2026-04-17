#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_ROOT="$ROOT_DIR/.wrangler/dev-state/v3"

mkdir -p "$STATE_ROOT/do/ripgit-Repository"
mkdir -p "$STATE_ROOT/do/gsv-os-Kernel"
mkdir -p "$STATE_ROOT/do/gsv-os-Process"
mkdir -p "$STATE_ROOT/do/gsv-channel-whatsapp-WhatsAppAccount"

cd "$ROOT_DIR/ripgit"
exec npm exec -- wrangler dev \
  -c ../gateway/wrangler.jsonc \
  -c ../adapters/whatsapp/wrangler.jsonc \
  -c wrangler.toml \
  --ip 0.0.0.0 \
  --persist-to ../.wrangler/dev-state
