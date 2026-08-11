#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--confirm" ]]; then
  echo "Usage: npm run managed:deploy -- --confirm" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_REF="${GSV_MANAGED_RELEASE_REF:-managed}"
RELEASE_DEFINE="$(node -p 'JSON.stringify(process.argv[1])' "$RELEASE_REF")"
ACCOUNTS_DEPLOY_ARGS=()
INFERENCE_DEPLOY_ARGS=()

if [[ -n "${GSV_MANAGED_ACCOUNTS_SECRETS_FILE:-}" ]]; then
  ACCOUNTS_DEPLOY_ARGS+=(--secrets-file "$GSV_MANAGED_ACCOUNTS_SECRETS_FILE")
fi
if [[ -n "${GSV_MANAGED_INFERENCE_SECRETS_FILE:-}" ]]; then
  INFERENCE_DEPLOY_ARGS+=(--secrets-file "$GSV_MANAGED_INFERENCE_SECRETS_FILE")
fi

npm run managed:check --prefix "$ROOT_DIR"

(
  cd "$ROOT_DIR/accounts"
  CI=1 npm exec --workspaces=false -- wrangler d1 migrations apply \
    gsv-accounts \
    --config wrangler.jsonc \
    --remote
  npm exec --workspaces=false -- wrangler deploy \
    --config wrangler.jsonc \
    --minify \
    "${ACCOUNTS_DEPLOY_ARGS[@]}"
)
(
  cd "$ROOT_DIR/inference"
  npm exec --workspaces=false -- wrangler deploy \
    --config wrangler.jsonc \
    --minify \
    "${INFERENCE_DEPLOY_ARGS[@]}"
)
(
  cd "$ROOT_DIR/ripgit"
  npm exec --workspaces=false -- wrangler deploy \
    --config wrangler.managed.jsonc \
    --minify
)
(
  cd "$ROOT_DIR/gateway"
  npm exec --workspaces=false -- wrangler deploy \
    --config wrangler.managed.jsonc \
    --minify \
    --define "__GSV_RELEASE__:$RELEASE_DEFINE"
)

echo "Managed GSV deployed. Inference remains governed by its source-controlled release gate."
