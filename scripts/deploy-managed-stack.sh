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
TELEGRAM_DEPLOY_ARGS=()
TELEGRAM_RECONCILE_ARGS=(--url "https://telegram.gsv.space/webhook")

if [[ -n "${GSV_MANAGED_ACCOUNTS_SECRETS_FILE:-}" ]]; then
  ACCOUNTS_DEPLOY_ARGS+=(--secrets-file "$GSV_MANAGED_ACCOUNTS_SECRETS_FILE")
fi
if [[ -n "${GSV_MANAGED_INFERENCE_SECRETS_FILE:-}" ]]; then
  INFERENCE_DEPLOY_ARGS+=(--secrets-file "$GSV_MANAGED_INFERENCE_SECRETS_FILE")
fi
if [[ -n "${GSV_MANAGED_TELEGRAM_SECRETS_FILE:-}" ]]; then
  TELEGRAM_DEPLOY_ARGS+=(--secrets-file "$GSV_MANAGED_TELEGRAM_SECRETS_FILE")
  TELEGRAM_RECONCILE_ARGS+=(--secrets-file "$GSV_MANAGED_TELEGRAM_SECRETS_FILE")
else
  echo "GSV_MANAGED_TELEGRAM_SECRETS_FILE is required for managed Telegram." >&2
  exit 2
fi

npm run managed:check --prefix "$ROOT_DIR"

(
  cd "$ROOT_DIR/adapters/email"
  if ! npm exec --workspaces=false -- wrangler queues info \
    gsv-managed-mail-outbound-dead-letter >/dev/null 2>&1; then
    npm exec --workspaces=false -- wrangler queues create \
      gsv-managed-mail-outbound-dead-letter \
      --message-retention-period-secs 1209600
  fi
  npm exec --workspaces=false -- wrangler queues update \
    gsv-managed-mail-outbound-dead-letter \
    --message-retention-period-secs 1209600
  if ! npm exec --workspaces=false -- wrangler queues info \
    gsv-managed-mail-outbound >/dev/null 2>&1; then
    npm exec --workspaces=false -- wrangler queues create \
      gsv-managed-mail-outbound \
      --message-retention-period-secs 1209600
  fi
  npm exec --workspaces=false -- wrangler queues update \
    gsv-managed-mail-outbound \
    --message-retention-period-secs 1209600
)

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
  if ! npm exec --workspaces=false -- wrangler deployments list \
    --name gsv-managed-telegram --json >/dev/null 2>&1; then
    BOOTSTRAP_CONFIG="$(mktemp "$ROOT_DIR/gateway/.wrangler-managed-bootstrap.XXXXXX.json")"
    trap 'rm -f -- "$BOOTSTRAP_CONFIG"' EXIT
    node -e '
      const fs = require("node:fs");
      const source = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      source.services = (source.services ?? []).filter(
        (binding) => binding.binding !== "CHANNEL_TELEGRAM",
      );
      fs.writeFileSync(process.argv[2], JSON.stringify(source));
    ' wrangler.managed.jsonc "$BOOTSTRAP_CONFIG"
    npm exec --workspaces=false -- wrangler deploy \
      --config "$BOOTSTRAP_CONFIG" \
      --minify \
      --define "__GSV_RELEASE__:$RELEASE_DEFINE"
  fi
)
(
  cd "$ROOT_DIR/adapters/telegram"
  npm exec --workspaces=false -- wrangler deploy \
    --config wrangler.managed.jsonc \
    --minify \
    "${TELEGRAM_DEPLOY_ARGS[@]}"
)
(
  cd "$ROOT_DIR/gateway"
  npm exec --workspaces=false -- wrangler deploy \
    --config wrangler.managed.jsonc \
    --minify \
    --define "__GSV_RELEASE__:$RELEASE_DEFINE"
)

node "$ROOT_DIR/scripts/reconcile-managed-telegram-webhook.mjs" \
  "${TELEGRAM_RECONCILE_ARGS[@]}"
(
  cd "$ROOT_DIR/adapters/email"
  npm exec --workspaces=false -- wrangler deploy \
    --config wrangler.jsonc \
    --minify
)

echo "Managed GSV deployed. Inference remains governed by Accounts policy."
