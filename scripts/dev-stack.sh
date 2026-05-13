#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PDS_DIR="${GSV_PDS_DIR:-$ROOT_DIR/pds}"
PDS_CONFIG="$PDS_DIR/wrangler.toml"
PERSIST_ROOT="${GSV_DEV_PERSIST_TO:-$ROOT_DIR/.wrangler/dev-state}"
STATE_ROOT="$PERSIST_ROOT/v3"
GENERATED_CONFIG_ROOT="$PERSIST_ROOT/generated"
IP="${GSV_DEV_IP:-0.0.0.0}"
DEV_FLAG="${GSV_DEV:-1}"
PDS_ADMIN_TOKEN_VALUE="${PDS_ADMIN_TOKEN:-gsv-dev-pds-admin-token}"

PORT_ARGS=()
if [[ -n "${GSV_DEV_PORT:-}" ]]; then
  PORT_ARGS+=(--port "$GSV_DEV_PORT")
fi

VAR_ARGS=(--var "GSV_DEV:$DEV_FLAG")
if [[ -n "${GSV_DEV_SOCIAL_ORIGINS:-}" ]]; then
  VAR_ARGS+=(--var "GSV_DEV_SOCIAL_ORIGINS:$GSV_DEV_SOCIAL_ORIGINS")
fi

if [[ ! -f "$PDS_CONFIG" ]]; then
  echo "PDS worker config not found at $PDS_CONFIG" >&2
  echo "Set GSV_PDS_DIR to an alternate pds repo path if needed." >&2
  exit 1
fi

export PDS_WORKER_ROOT="$PDS_DIR"
export GSV_WORKER_BUILD="$ROOT_DIR/scripts/worker-build.sh"
PDS_DEV_CONFIG="$GENERATED_CONFIG_ROOT/pds.wrangler.toml"

toml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

mkdir -p "$STATE_ROOT/do/ripgit-Repository"
mkdir -p "$STATE_ROOT/do/gsv-Kernel"
mkdir -p "$STATE_ROOT/do/gsv-Process"
mkdir -p "$STATE_ROOT/do/gsv-channel-whatsapp-WhatsAppAccount"
mkdir -p "$STATE_ROOT/do/gsv-pds-RepoObject"
mkdir -p "$STATE_ROOT/do/gsv-pds-PdsDirectoryObject"
mkdir -p "$GENERATED_CONFIG_ROOT"

sed \
  -e "s|^main = .*|main = \"$PDS_DIR/src/entrypoint.ts\"|" \
  -e "s|^GSV_DEV = .*|GSV_DEV = \"$(toml_escape "$DEV_FLAG")\"|" \
  -e "s|^GSV_DEV_SOCIAL_ORIGINS = .*|GSV_DEV_SOCIAL_ORIGINS = \"$(toml_escape "${GSV_DEV_SOCIAL_ORIGINS:-}")\"|" \
  "$PDS_CONFIG" \
  | awk -v token="$(toml_escape "$PDS_ADMIN_TOKEN_VALUE")" '
      /^\[vars\]$/ {
        print;
        print "PDS_ADMIN_TOKEN = \"" token "\"";
        next;
      }
      /^PDS_ADMIN_TOKEN = / { next; }
      { print; }
    ' > "$PDS_DEV_CONFIG"

cd "$ROOT_DIR/ripgit"
exec npm exec -- wrangler dev \
  -c ../gateway/wrangler.jsonc \
  -c "$PDS_DEV_CONFIG" \
  -c ../assembler/wrangler.toml \
  -c ../adapters/whatsapp/wrangler.jsonc \
  -c wrangler.toml \
  --ip "$IP" \
  --persist-to "$PERSIST_ROOT" \
  "${VAR_ARGS[@]}" \
  "${PORT_ARGS[@]}"
