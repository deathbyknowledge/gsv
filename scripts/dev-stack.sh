#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_STATE_DIR="${GSV_DEV_STATE_DIR:-$ROOT_DIR/.wrangler/operator-dev-state}"
mkdir -p "$DEV_STATE_DIR"
DEV_STATE_DIR="$(cd "$DEV_STATE_DIR" && pwd -P)"

cd "$ROOT_DIR"
npm run gsv:build
npm run build --workspace web

(
  cd "$ROOT_DIR/workers/installations"
  CI=1 npm exec --workspaces=false -- wrangler d1 migrations apply INSTALLATIONS_DB \
    --config wrangler.dev.jsonc --local --persist-to "$DEV_STATE_DIR"
)

printf '\nGSV is starting on http://localhost:8976\n'
printf 'Open http://localhost:8976/admin to create an installation.\n'
printf 'The local administration bypass is limited to the configured localhost origin.\n'
printf 'State: %s\n\n' "$DEV_STATE_DIR"

cd "$ROOT_DIR/workers/ripgit"
exec env CLOUDFLARE_INCLUDE_PROCESS_ENV=false npm exec --workspaces=false -- wrangler dev \
  --config "$ROOT_DIR/workers/gateway/wrangler.dev.jsonc" \
  --config "$ROOT_DIR/workers/installations/wrangler.dev.jsonc" \
  --config "$ROOT_DIR/workers/inference/wrangler.dev.jsonc" \
  --config "$ROOT_DIR/workers/ripgit/wrangler.dev.jsonc" \
  --ip 0.0.0.0 --port 8976 --local --persist-to "$DEV_STATE_DIR"
