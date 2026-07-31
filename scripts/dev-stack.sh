#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_STATE_DIR="${GSV_DEV_STATE_DIR:-$ROOT_DIR/.wrangler/dev-state}"
STATE_ROOT="$DEV_STATE_DIR/v3"

mkdir -p "$STATE_ROOT/do/ripgit-Repository"
mkdir -p "$STATE_ROOT/do/gsv-Kernel"
mkdir -p "$STATE_ROOT/do/gsv-Process"
mkdir -p "$STATE_ROOT/do/gsv-channel-telegram-TelegramAccount"
mkdir -p "$STATE_ROOT/do/gsv-channel-whatsapp-WhatsAppAccount"
mkdir -p "$STATE_ROOT/do/gsv-channel-discord-DiscordGateway"

cd "$ROOT_DIR/ripgit"
exec npm exec -- wrangler dev \
  -c ../gateway/wrangler.jsonc \
  -c ../adapters/telegram/wrangler.jsonc \
  -c ../adapters/whatsapp/wrangler.jsonc \
  -c ../adapters/discord/wrangler.jsonc \
  -c wrangler.toml \
  --ip 0.0.0.0 \
  --persist-to "$DEV_STATE_DIR"
