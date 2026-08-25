#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

case "${1:-}" in
  --help|-h)
    cat <<'USAGE'
Usage: scripts/demo-fleet/stop-fleet.sh

Removes containers labeled for DEMO_FLEET_ID. It also removes legacy unlabeled
demo containers only after verifying their exact name, image, device id, and
/fleet workspace mount. Other prefix-matching containers are never removed.
USAGE
    exit 0
    ;;
  "") ;;
  *) die "unknown argument: $1" ;;
esac

validate_common_config
require_docker

declare -a container_ids=()
declare -A seen=()
while IFS= read -r container_id; do
  [[ -n "$container_id" && -z "${seen[$container_id]:-}" ]] || continue
  seen[$container_id]=1
  container_ids+=("$container_id")
done < <(owned_container_ids)
while IFS= read -r container_id; do
  [[ -n "$container_id" && -z "${seen[$container_id]:-}" ]] || continue
  seen[$container_id]=1
  container_ids+=("$container_id")
done < <(verified_legacy_container_ids)

if [[ "${#container_ids[@]}" -eq 0 ]]; then
  echo "No owned demo fleet containers found"
  exit 0
fi

remove_containers_bounded "${container_ids[@]}" \
  || die "failed to remove one or more owned demo fleet containers"
echo "Removed ${#container_ids[@]} owned demo fleet containers"
