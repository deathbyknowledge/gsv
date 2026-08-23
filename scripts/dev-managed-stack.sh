#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICES_ROOT="${GSV_MANAGED_SERVICES_ROOT:?Set GSV_MANAGED_SERVICES_ROOT to a directory containing accounts/ and inference/ service implementations}"
ACCOUNTS_DIR="$SERVICES_ROOT/accounts"
INFERENCE_DIR="$SERVICES_ROOT/inference"
STATE_DIR="${GSV_MANAGED_DEV_STATE_DIR:-$ROOT_DIR/.wrangler/managed-dev-state}"
MANAGED_ENV_FILE="${GSV_MANAGED_ENV_FILE:-$ROOT_DIR/scripts/managed.env}"

mkdir -p "$STATE_DIR"
STATE_DIR="$(cd "$STATE_DIR" && pwd -P)"

cd "$ROOT_DIR"
npm run gsv:build
npm run build --workspace web

cd "$ACCOUNTS_DIR"
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
  --config "$ROOT_DIR/gateway/wrangler.managed.dev.jsonc" \
  --config "$ACCOUNTS_DIR/wrangler.dev.jsonc" \
  --config "$INFERENCE_DIR/wrangler.dev.jsonc" \
  --config "$ROOT_DIR/ripgit/wrangler.managed.dev.jsonc" \
  --config "$ROOT_DIR/adapters/email/wrangler.dev.jsonc" \
  --ip 0.0.0.0 \
  --port 8976 \
  --env-file "$MANAGED_ENV_FILE" \
  --local \
  --persist-to "$STATE_DIR"
