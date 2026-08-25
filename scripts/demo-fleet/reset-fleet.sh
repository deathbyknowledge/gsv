#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

restart=0
build=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart)
      restart=1
      shift
      ;;
    --build)
      restart=1
      build=1
      shift
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/demo-fleet/reset-fleet.sh [--restart] [--build]

Stops the fleet and recreates the deterministic baseline. --restart starts and
waits for the fleet afterward; --build also rebuilds the current-main image.
USAGE
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

validate_common_config
require_command node
if [[ "$restart" -eq 1 ]]; then
  validate_gateway_inputs
  require_docker
  load_device_tokens
fi

"$SCRIPT_DIR/stop-fleet.sh"
node "$SCRIPT_DIR/seed-fleet.mjs" \
  --root "$FLEET_DIR" \
  --truth "$GROUND_TRUTH_FILE" \
  --devices "$DEVICE_COUNT"
node "$SCRIPT_DIR/verify-fleet.mjs" \
  --root "$FLEET_DIR" \
  --truth "$GROUND_TRUTH_FILE" \
  --expect baseline

if [[ "$restart" -eq 1 ]]; then
  start_args=()
  [[ "$build" -eq 1 ]] && start_args+=(--build)
  "$SCRIPT_DIR/start-fleet.sh" "${start_args[@]}"
else
  echo "Fleet reset to the stopped baseline"
fi
