#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

build=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      build=1
      shift
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/demo-fleet/prepare-fleet.sh [--build]

One-command recording preparation: validates inputs, stops the old fleet,
seeds and verifies the baseline, starts every expected container, and waits for
current gateway connections. Use --build after CLI changes.
USAGE
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

validate_common_config
validate_gateway_inputs
require_command node
require_docker
load_device_tokens

"$SCRIPT_DIR/stop-fleet.sh"
node "$SCRIPT_DIR/seed-fleet.mjs" \
  --root "$FLEET_DIR" \
  --truth "$GROUND_TRUTH_FILE" \
  --devices "$DEVICE_COUNT"
node "$SCRIPT_DIR/verify-fleet.mjs" \
  --root "$FLEET_DIR" \
  --truth "$GROUND_TRUTH_FILE" \
  --expect baseline

start_args=()
[[ "$build" -eq 1 ]] && start_args+=(--build)
"$SCRIPT_DIR/start-fleet.sh" "${start_args[@]}"
"$SCRIPT_DIR/status.sh" --check
echo "Recording-ready: deterministic baseline is online on $START_LIMIT devices"
