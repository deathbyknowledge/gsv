#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gsv-managed-check.XXXXXX")"

cleanup() {
  rm -rf "${OUTPUT_DIR}"
}
trap cleanup EXIT

run_wrangler() {
  local component="$1"
  local config="$2"
  local output="$3"
  (
    cd "${ROOT_DIR}/${component}"
    npm exec --workspaces=false -- wrangler deploy \
      --config "${config}" \
      --minify \
      --dry-run \
      --outdir "${OUTPUT_DIR}/${output}"
  )
}

generate_types() {
  local component="$1"
  local config="$2"
  local output="$3"
  local interface_name="$4"
  local include_runtime="${5:-true}"
  (
    cd "${ROOT_DIR}/${component}"
    npm exec --workspaces=false -- wrangler types \
      "${OUTPUT_DIR}/types/${output}.d.ts" \
      --config "${config}" \
      --env-interface "${interface_name}" \
      --include-runtime "${include_runtime}"
  )
}

mkdir -p "${OUTPUT_DIR}/types"

node "${ROOT_DIR}/scripts/validate-managed-topology.mjs"

npm run gsv:check --prefix "${ROOT_DIR}"
npm run check --workspace web --prefix "${ROOT_DIR}"
npm run build --workspace web --prefix "${ROOT_DIR}"
npm run build:account --workspace web --prefix "${ROOT_DIR}"
npm exec --workspace gateway -- tsc --noEmit
npm run typecheck --workspace gsv-account-service --prefix "${ROOT_DIR}"
npm run typecheck --workspace gsv-inference-service --prefix "${ROOT_DIR}"
npm run typecheck --prefix "${ROOT_DIR}/adapters/telegram"

generate_types "gateway" "wrangler.managed.jsonc" "gateway" "ManagedGatewayEnv"
generate_types "account-service" "wrangler.jsonc" "account" "ManagedAccountEnv"
generate_types "inference-service" "wrangler.jsonc" "inference" "ManagedInferenceEnv"
generate_types \
  "adapters/telegram" \
  "wrangler.managed.jsonc" \
  "telegram" \
  "ManagedTelegramEnv" \
  "false"
generate_types "ripgit" "wrangler.managed.jsonc" "ripgit" "ManagedRipgitEnv"

run_wrangler "gateway" "wrangler.managed.jsonc" "gateway"
run_wrangler "account-service" "wrangler.jsonc" "account"
run_wrangler "inference-service" "wrangler.jsonc" "inference"
run_wrangler "adapters/telegram" "wrangler.managed.jsonc" "telegram"
run_wrangler "ripgit" "wrangler.managed.jsonc" "ripgit"
run_wrangler "gateway" \
  "../deployment/managed/bootstrap/wrangler.jsonc" \
  "bootstrap"

echo "Managed GSV configs, types, Worker bundles, and bootstrap are valid."
