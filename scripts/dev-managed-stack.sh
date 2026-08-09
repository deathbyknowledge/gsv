#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${GSV_MANAGED_DEV_STATE_DIR:-$ROOT_DIR/.wrangler/managed-dev-state}"
MANAGED_ENV_FILE="$ROOT_DIR/scripts/managed.env"

mkdir -p "$STATE_DIR"
STATE_DIR="$(cd "$STATE_DIR" && pwd -P)"

cd "$ROOT_DIR"
npm run gsv:build
npm run build --workspace web

cd "$ROOT_DIR/accounts"
CI=1 npm exec --workspaces=false -- wrangler d1 migrations apply ACCOUNT_DB \
  --config wrangler.dev.jsonc \
  --local \
  --persist-to "$STATE_DIR"

printf '\nManaged GSV is starting on http://localhost:8976\n'
printf 'Open http://localhost:8976/admin to create an installation.\n'
printf 'Then open the one-time onboarding link issued by the registry.\n'
printf 'State: %s\n\n' "$STATE_DIR"

exec env \
  CLOUDFLARE_INCLUDE_PROCESS_ENV=false \
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  npm exec --workspaces=false -- wrangler dev \
  --config ../gateway/wrangler.managed.dev.jsonc \
  --config wrangler.dev.jsonc \
  --config ../ripgit/wrangler.managed.dev.jsonc \
  --ip 127.0.0.1 \
  --port 8976 \
  --env-file "$MANAGED_ENV_FILE" \
  --local \
  --persist-to "$STATE_DIR"
