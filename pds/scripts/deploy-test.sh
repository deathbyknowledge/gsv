#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .dev.vars ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.dev.vars
  set +a
fi

if [[ -z "${PDS_ADMIN_TOKEN:-}" ]]; then
  echo "PDS_ADMIN_TOKEN is required. Set it in the environment or .dev.vars." >&2
  exit 2
fi

required_wrangler_vars=(PDS_LEXICON_AUTHORITY_DIDS)
missing_wrangler_vars=()
for name in "${required_wrangler_vars[@]}"; do
  if ! grep -Eq "^[[:space:]]*${name}[[:space:]]*=" wrangler.toml; then
    missing_wrangler_vars+=("$name")
  fi
done

if ((${#missing_wrangler_vars[@]})); then
  printf 'wrangler.toml is missing required non-secret [vars]: %s\n' \
    "${missing_wrangler_vars[*]}" >&2
  exit 2
fi

if grep -Eq '^[[:space:]]*workers_dev[[:space:]]*=[[:space:]]*false' wrangler.toml; then
  cat >&2 <<'MSG'
wrangler.toml currently has workers_dev = false.
That is fine if you configured a route/custom domain, but for a quick workers.dev test
set workers_dev = true or pass a config that enables a public route.

MSG
fi

npm run audit:xrpc

printf '%s\n' "$PDS_ADMIN_TOKEN" | npx wrangler secret put PDS_ADMIN_TOKEN
if [[ -n "${PDS_PLC_ROTATION_KEY_P256_HEX:-}" ]]; then
  printf '%s\n' "$PDS_PLC_ROTATION_KEY_P256_HEX" | npx wrangler secret put PDS_PLC_ROTATION_KEY_P256_HEX
fi
npx wrangler deploy "$@"

if [[ -n "${PDS_BASE_URL:-}" ]]; then
  npm run seed:test-repo
  npm run smoke:account
  npm run smoke:delete-account
  npm run smoke:public
  npm run smoke:lexicon
  npm run smoke:oauth:client
  if [[ -n "${PDS_PLC_ROTATION_KEY_P256_HEX:-}" ]]; then
    npm run smoke:plc-account
    npm run smoke:migration
    npm run smoke:firehose
    npm run smoke:firehose:cursor
    npm run smoke:firehose:oversize
    npm run smoke:client
    npm run smoke:conformance
  else
    echo "Skipping smoke:plc-account, smoke:migration, smoke:firehose, smoke:firehose:cursor, smoke:firehose:oversize, smoke:client, and smoke:conformance; set PDS_PLC_ROTATION_KEY_P256_HEX to enable did:plc account creation, migration, firehose, and official client tests."
  fi
  if [[ -n "${OAUTH_CONFIDENTIAL_CLIENT_ID:-}" && -n "${OAUTH_CONFIDENTIAL_CLIENT_PRIVATE_KEY_JWK:-}" ]]; then
    npm run smoke:oauth:confidential
  else
    echo "Skipping smoke:oauth:confidential; set OAUTH_CONFIDENTIAL_CLIENT_ID and OAUTH_CONFIDENTIAL_CLIENT_PRIVATE_KEY_JWK to enable it."
  fi
  exit 0
fi

cat <<'MSG'

Deployment finished.

Run remote smokes with:
  PDS_BASE_URL=https://<your-worker-host> \
  PDS_ADMIN_TOKEN=<same-token> \
  npm run seed:test-repo && \
  npm run smoke:account && \
  npm run smoke:delete-account && \
  npm run smoke:public && \
  npm run smoke:lexicon && \
  npm run smoke:oauth:client

Optional did:plc account smoke:
  PDS_PLC_ROTATION_KEY_P256_HEX=<server-rotation-p256-hex> \
  npm run smoke:plc-account && \
  npm run smoke:migration && \
  npm run smoke:firehose && \
  npm run smoke:firehose:cursor && \
  npm run smoke:firehose:oversize && \
  npm run smoke:client && \
  npm run smoke:conformance

Optional confidential OAuth smoke:
  OAUTH_CONFIDENTIAL_CLIENT_ID=https://client.example.com/client.json \
  OAUTH_CONFIDENTIAL_CLIENT_PRIVATE_KEY_JWK=@private-client-key.jwk \
  npm run smoke:oauth:confidential

MSG
