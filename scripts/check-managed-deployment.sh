#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICES_ROOT="${GSV_MANAGED_SERVICES_ROOT:?Set GSV_MANAGED_SERVICES_ROOT to a directory containing accounts/ and inference/ service implementations}"
ACCOUNTS_DIR="$SERVICES_ROOT/accounts"
INFERENCE_DIR="$SERVICES_ROOT/inference"
OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gsv-managed-check.XXXXXX")"

cleanup() {
  rm -r -- "$OUTPUT_DIR"
}
trap cleanup EXIT

run_wrangler() {
  local component_dir="$1"
  local config="$2"
  local output="$3"
  (
    cd "$component_dir"
    npm exec --workspaces=false -- wrangler deploy \
      --config "$config" \
      --minify \
      --dry-run \
      --outdir "$OUTPUT_DIR/$output"
  )
}

generate_types() {
  local component_dir="$1"
  local config="$2"
  local output="$3"
  local interface_name="$4"
  (
    cd "$component_dir"
    npm exec --workspaces=false -- wrangler types \
      "$OUTPUT_DIR/$output.d.ts" \
      --config "$config" \
      --env-interface "$interface_name"
  )
}

if rg -q \
  'INSTALLATION_DIRECTORY|MANAGED_INFERENCE|gsv-accounts|gsv-inference|gsv-managed' \
  "$ROOT_DIR/workers/gateway/wrangler.jsonc"; then
  echo "Standalone Gateway configuration includes managed infrastructure." >&2
  exit 1
fi
if rg -q 'wrangler\.managed|gsv-accounts|gsv-inference' \
  "$ROOT_DIR/scripts/build-cloudflare-bundles.sh"; then
  echo "Standalone release bundles include managed infrastructure." >&2
  exit 1
fi

npm run gsv:check --prefix "$ROOT_DIR"
npm run build --workspace web --prefix "$ROOT_DIR"
npm run typecheck --prefix "$ACCOUNTS_DIR"
npm run typecheck --prefix "$INFERENCE_DIR"
npm exec --workspace gateway -- tsc --noEmit
npm run check --prefix "$ROOT_DIR/workers/adapters/email" --workspaces=false
npm run typecheck --prefix "$ROOT_DIR/workers/adapters/telegram" --workspaces=false
npm run test:managed --prefix "$ROOT_DIR/workers/adapters/telegram" --workspaces=false
npm run typecheck --prefix "$ROOT_DIR/workers/adapters/slack" --workspaces=false
npm run test --prefix "$ROOT_DIR/workers/adapters/slack" --workspaces=false
npm run test:standalone --prefix "$ROOT_DIR/workers/adapters/slack" --workspaces=false
npm run test:managed --prefix "$ROOT_DIR/workers/adapters/slack" --workspaces=false

generate_types "$ACCOUNTS_DIR" "wrangler.jsonc" "accounts" "ManagedAccountsEnv"
generate_types "$INFERENCE_DIR" "wrangler.jsonc" "inference" "ManagedInferenceEnv"
generate_types "$ROOT_DIR/workers/gateway" "wrangler.managed.jsonc" "gateway" "ManagedGatewayEnv"
generate_types "$ROOT_DIR/workers/adapters/email" "wrangler.jsonc" "email" "ManagedEmailEnv"
generate_types "$ROOT_DIR/workers/adapters/telegram" "wrangler.managed.jsonc" "telegram" "ManagedTelegramEnv"
generate_types "$ROOT_DIR/workers/adapters/slack" "wrangler.managed.jsonc" "slack" "ManagedSlackEnv"

run_wrangler "$ACCOUNTS_DIR" "wrangler.jsonc" "accounts"
run_wrangler "$INFERENCE_DIR" "wrangler.jsonc" "inference"
run_wrangler "$ROOT_DIR/workers/ripgit" "wrangler.managed.jsonc" "ripgit"
run_wrangler "$ROOT_DIR/workers/gateway" "wrangler.managed.jsonc" "gateway"
run_wrangler "$ROOT_DIR/workers/adapters/email" "wrangler.jsonc" "email"
run_wrangler "$ROOT_DIR/workers/adapters/telegram" "wrangler.managed.jsonc" "telegram"
run_wrangler "$ROOT_DIR/workers/adapters/slack" "wrangler.managed.jsonc" "slack"

echo "Managed production configs and Worker bundles are valid."
