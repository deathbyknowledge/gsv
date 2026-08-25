#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

keep_file=0
stop_first=0
reason="demo fleet cleanup"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-file)
      keep_file=1
      shift
      ;;
    --stop)
      stop_first=1
      shift
      ;;
    --reason)
      [[ $# -ge 2 ]] || die "--reason requires text"
      reason="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/demo-fleet/revoke-device-tokens.sh [--stop] [--keep-file]
                                                   [--reason TEXT]

Explicitly revokes every token id in the generated CSV. The CSV is deleted only
after all revoke calls succeed. Requests share one persistent SDK connection.
GSV_USER_TOKEN is required. --stop removes fleet containers first.
USAGE
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

validate_common_config
validate_gateway_inputs
require_command node
[[ -z "${GSV_PASSWORD:-}" ]] \
  || die "GSV_PASSWORD is not accepted here; set GSV_USER_TOKEN"
[[ -n "${GSV_USER_TOKEN:-}" ]] || die "GSV_USER_TOKEN is required"

if [[ "$stop_first" -eq 1 ]]; then
  "$SCRIPT_DIR/stop-fleet.sh"
fi

args=(
  revoke
  --count "$DEVICE_COUNT"
  --token-file "$TOKENS_FILE"
  --reason "$reason"
)
if [[ "$keep_file" -eq 1 ]]; then
  args+=(--keep-file)
fi
exec node "$SCRIPT_DIR/bulk-device-tokens.mjs" "${args[@]}"
