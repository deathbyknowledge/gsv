#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

force=0
ttl_hours="${DEMO_FLEET_TOKEN_TTL_HOURS:-12}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      force=1
      shift
      ;;
    --ttl-hours)
      [[ $# -ge 2 ]] || die "--ttl-hours requires a value"
      ttl_hours="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/demo-fleet/create-device-tokens.sh [--force] [--ttl-hours N]

Creates short-lived device tokens (12 hours by default) over one persistent GSV
SDK connection. GSV_USER_TOKEN is required. GSV_PASSWORD and the CLI credential
cache are intentionally not read.

--force creates a complete replacement set and revokes the previous token ids.
A partial new set is revoked automatically on failure. Tune bounded requests
with DEMO_FLEET_TOKEN_CONCURRENCY and DEMO_FLEET_TOKEN_PACE_MS.
USAGE
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

validate_common_config
validate_integer "token TTL hours" "$ttl_hours" 1 168
validate_gateway_inputs
require_command node
[[ -z "${GSV_PASSWORD:-}" ]] \
  || die "GSV_PASSWORD is not accepted here; set GSV_USER_TOKEN"
[[ -n "${GSV_USER_TOKEN:-}" ]] || die "GSV_USER_TOKEN is required"
validate_workspaces "$DEVICE_COUNT"

if [[ -f "$TOKENS_FILE" && "$force" -ne 1 ]]; then
  die "$TOKENS_FILE already exists; pass --force to rotate and revoke it"
fi
if [[ "$TOKENS_FILE" == "$ROOT_DIR/"* ]] && command -v git >/dev/null 2>&1; then
  relative_tokens="${TOKENS_FILE#"$ROOT_DIR/"}"
  git -C "$ROOT_DIR" check-ignore -q -- "$relative_tokens" \
    || die "refusing to write secret material to a non-ignored path: $TOKENS_FILE"
fi

args=(
  create
  --count "$DEVICE_COUNT"
  --token-file "$TOKENS_FILE"
  --fleet-id "$FLEET_ID"
  --ttl-hours "$ttl_hours"
)
if [[ "$force" -eq 1 ]]; then
  args+=(--force)
fi
exec node "$SCRIPT_DIR/bulk-device-tokens.mjs" "${args[@]}"
