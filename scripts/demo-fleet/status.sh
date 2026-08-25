#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

verbose=0
check=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose|-v)
      verbose=1
      shift
      ;;
    --check|--ready)
      check=1
      shift
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/demo-fleet/status.sh [--verbose] [--check]

Default output is a one-line fleet summary. --verbose lists every expected
container. --check (alias --ready) exits nonzero unless all expected devices
are both running and currently connected.
USAGE
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

validate_common_config

seeded=0
if [[ -d "$FLEET_DIR" ]]; then
  while IFS= read -r workspace; do
    device_id="${workspace##*/}"
    is_canonical_device_id "$device_id" && seeded=$((seeded + 1))
  done < <(find "$FLEET_DIR" -mindepth 1 -maxdepth 1 -type d -name 'edge-*' -print)
fi
tokens=0
if [[ -f "$TOKENS_FILE" ]]; then
  tokens="$(awk 'NR > 1 { count += 1 } END { print count + 0 }' "$TOKENS_FILE")"
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Demo fleet: UNAVAILABLE (Docker daemon unreachable; seeded $seeded, tokens $tokens)"
  [[ "$check" -eq 0 ]]
  exit
fi

running=0
connected=0
present=0
conflicts=0
refresh_container_inventory
declare -a row_names=()
declare -a row_ownership=()
declare -a running_names=()
declare -A expected_set=()
for ((i = 1; i <= START_LIMIT; i += 1)); do
  device_id="$(device_id_for_index "$i")"
  container_name="$(container_name_for_device "$device_id")"
  expected_set[$container_name]=1
  ownership="missing"
  if [[ -n "${CONTAINER_ID_SNAPSHOT[$container_name]:-}" ]]; then
    if snapshot_container_matches_device "$container_name" "$device_id"; then
      ownership="owned"
    elif container_is_verified_legacy "$container_name" "$device_id"; then
      ownership="legacy"
    else
      ownership="conflict"
      conflicts=$((conflicts + 1))
    fi
    if [[ "$ownership" != "conflict" ]]; then
      present=$((present + 1))
      if [[ "${CONTAINER_STATE_SNAPSHOT[$container_name]}" == "running" ]]; then
        running=$((running + 1))
        running_names+=("$container_name")
      fi
    fi
  fi
  row_names+=("$container_name")
  row_ownership+=("$ownership")
done

collect_container_connection_states "${running_names[@]}"
for container_name in "${running_names[@]}"; do
  [[ "${CONNECTION_STATE_BY_NAME[$container_name]:-unknown}" == "connected" ]] \
    && connected=$((connected + 1))
done

extras=0
for container_name in "${!CONTAINER_ID_SNAPSHOT[@]}"; do
  if snapshot_container_is_owned "$container_name" \
    && [[ -z "${expected_set[$container_name]:-}" ]]; then
    extras=$((extras + 1))
  fi
done

if [[ "$running" -eq "$START_LIMIT" \
  && "$connected" -eq "$START_LIMIT" \
  && "$seeded" -eq "$DEVICE_COUNT" \
  && "$tokens" -eq "$DEVICE_COUNT" \
  && "$extras" -eq 0 \
  && "$conflicts" -eq 0 ]]; then
  readiness="READY"
else
  readiness="NOT READY"
fi

echo "Demo fleet: $readiness ($running/$START_LIMIT running, $connected/$START_LIMIT connected; seeded $seeded, tokens $tokens; image $(image_revision))"
if [[ "$extras" -gt 0 || "$conflicts" -gt 0 ]]; then
  echo "  attention: $extras extra owned containers, $conflicts expected-name conflicts"
fi

if [[ "$verbose" -eq 1 ]]; then
  printf '\n%-18s %-10s %s\n' "CONTAINER" "OWNERSHIP" "STATE"
  for ((i = 0; i < ${#row_names[@]}; i += 1)); do
    container_name="${row_names[$i]}"
    ownership="${row_ownership[$i]}"
    if [[ "$ownership" == "conflict" ]]; then
      state="not-owned"
    elif [[ "$ownership" == "missing" ]]; then
      state="missing"
    elif [[ "${CONTAINER_STATE_SNAPSHOT[$container_name]:-}" != "running" ]]; then
      state="${CONTAINER_STATE_SNAPSHOT[$container_name]:-stopped}"
    else
      state="${CONNECTION_STATE_BY_NAME[$container_name]:-unknown}"
    fi
    printf '%-18s %-10s %s\n' "$container_name" "$ownership" "$state"
  done
fi

if [[ "$check" -eq 1 && "$readiness" != "READY" ]]; then
  exit 1
fi
