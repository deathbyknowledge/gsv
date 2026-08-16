#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gsv-managed-check.XXXXXX")"

cleanup() {
  rm -r -- "$OUTPUT_DIR"
}
trap cleanup EXIT

run_wrangler() {
  local component="$1"
  local config="$2"
  local output="$3"
  (
    cd "$ROOT_DIR/$component"
    npm exec --workspaces=false -- wrangler deploy \
      --config "$config" \
      --minify \
      --dry-run \
      --outdir "$OUTPUT_DIR/$output"
  )
}

generate_types() {
  local component="$1"
  local config="$2"
  local output="$3"
  local interface_name="$4"
  (
    cd "$ROOT_DIR/$component"
    npm exec --workspaces=false -- wrangler types \
      "$OUTPUT_DIR/$output.d.ts" \
      --config "$config" \
      --env-interface "$interface_name" \
      --include-runtime false
  )
}

if rg -q \
  'INSTALLATION_DIRECTORY|MANAGED_INFERENCE|gsv-accounts|gsv-inference|gsv-managed' \
  "$ROOT_DIR/gateway/wrangler.jsonc"; then
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
npm run typecheck --workspace gsv-accounts --prefix "$ROOT_DIR"
npm run typecheck --workspace gsv-inference --prefix "$ROOT_DIR"
npm exec --workspace gateway -- tsc --noEmit
npm run check --prefix "$ROOT_DIR/adapters/email" --workspaces=false
npm run typecheck --prefix "$ROOT_DIR/adapters/telegram" --workspaces=false
npm run test:managed --prefix "$ROOT_DIR/adapters/telegram" --workspaces=false

generate_types "accounts" "wrangler.jsonc" "accounts" "ManagedAccountsEnv"
generate_types "inference" "wrangler.jsonc" "inference" "ManagedInferenceEnv"
generate_types "gateway" "wrangler.managed.jsonc" "gateway" "ManagedGatewayEnv"
generate_types "adapters/email" "wrangler.jsonc" "email" "ManagedEmailEnv"
generate_types "adapters/telegram" "wrangler.managed.jsonc" "telegram" "ManagedTelegramEnv"

run_wrangler "accounts" "wrangler.jsonc" "accounts"
run_wrangler "inference" "wrangler.jsonc" "inference"
run_wrangler "ripgit" "wrangler.managed.jsonc" "ripgit"
run_wrangler "gateway" "wrangler.managed.jsonc" "gateway"
run_wrangler "adapters/email" "wrangler.jsonc" "email"
run_wrangler "adapters/telegram" "wrangler.managed.jsonc" "telegram"

echo "Managed production configs and Worker bundles are valid."
