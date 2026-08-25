#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

case "${1:-}" in
  --help|-h)
    echo "Usage: scripts/demo-fleet/build-image.sh"
    exit 0
    ;;
  "") ;;
  *) die "unknown argument: $1" ;;
esac

validate_common_config
require_docker

context_dir="$GENERATED_DIR/docker-context"
rm -rf "$context_dir"
mkdir -p "$context_dir"
cp -R "$ROOT_DIR/cli" "$context_dir/cli"
rm -rf "$context_dir/cli/target"
cp "$SCRIPT_DIR/entrypoint.sh" "$context_dir/entrypoint.sh"

source_rev="unknown"
if command -v git >/dev/null 2>&1; then
  source_rev="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown')"
fi

docker build \
  -f "$SCRIPT_DIR/Dockerfile" \
  -t "$IMAGE_NAME" \
  --build-arg "GSV_SOURCE_REV=$source_rev" \
  "$context_dir"

echo "Built $IMAGE_NAME (source $source_rev)"
