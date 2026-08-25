#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

replace=0
resume=0
build=0
wait_for_ready=1
wait_timeout="${DEMO_FLEET_WAIT_TIMEOUT:-120}"
stable_samples_required="${DEMO_FLEET_STABLE_SAMPLES:-3}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --replace)
      replace=1
      shift
      ;;
    --resume|--scale-up)
      resume=1
      shift
      ;;
    --build)
      build=1
      shift
      ;;
    --no-wait)
      wait_for_ready=0
      shift
      ;;
    --wait-timeout)
      [[ $# -ge 2 ]] || die "--wait-timeout requires seconds"
      wait_timeout="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/demo-fleet/start-fleet.sh [--build] [--replace|--resume] [--no-wait]
                                          [--wait-timeout SECONDS]

Starts DEMO_FLEET_START_LIMIT containers (default: every device), then waits
for every expected container's latest connection event to be connect.ok.

--resume (alias --scale-up) preserves exact running containers owned by this
fleet and creates only missing devices. Use it for staged limits such as
100 -> 250 -> 500 -> 750 -> 1000. A failed stage removes only that stage.

Resource defaults are overridable with DEMO_FLEET_MEMORY, DEMO_FLEET_CPUS,
DEMO_FLEET_PIDS_LIMIT, DEMO_FLEET_LOG_SIZE, and DEMO_FLEET_LOG_FILES. Startup
and connection-check concurrency are controlled by DEMO_FLEET_START_PARALLELISM
and DEMO_FLEET_CHECK_PARALLELISM.
USAGE
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$replace" -eq 0 || "$resume" -eq 0 ]] || die "--replace and --resume are mutually exclusive"
[[ "$build" -eq 0 || "$resume" -eq 0 ]] \
  || die "--build cannot be combined with --resume; build before the first ramp stage"

validate_common_config
validate_integer "wait timeout" "$wait_timeout" 1 3600
validate_integer "DEMO_FLEET_STABLE_SAMPLES" "$stable_samples_required" 1 10
validate_gateway_inputs
require_docker
load_device_tokens
validate_workspaces "$START_LIMIT"

memory="${DEMO_FLEET_MEMORY:-128m}"
cpus="${DEMO_FLEET_CPUS:-0.25}"
pids_limit="${DEMO_FLEET_PIDS_LIMIT:-64}"
log_size="${DEMO_FLEET_LOG_SIZE:-2m}"
log_files="${DEMO_FLEET_LOG_FILES:-2}"
validate_integer "DEMO_FLEET_PIDS_LIMIT" "$pids_limit" 16 4096
validate_integer "DEMO_FLEET_LOG_FILES" "$log_files" 1 20

if [[ "$build" -eq 1 ]] || ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  "$SCRIPT_DIR/build-image.sh"
fi

refresh_container_inventory
declare -a replacement_ids=()
declare -a expected_names=()
declare -a new_indexes=()
declare -A expected_set=()
retained=0
for ((i = 0; i < START_LIMIT; i += 1)); do
  device_id="${TOKEN_DEVICE_IDS[$i]}"
  container_name="$(container_name_for_device "$device_id")"
  expected_names+=("$container_name")
  expected_set[$container_name]=1
  if [[ -z "${CONTAINER_ID_SNAPSHOT[$container_name]:-}" ]]; then
    new_indexes+=("$i")
    continue
  fi

  if [[ "$resume" -eq 1 ]]; then
    snapshot_container_matches_device "$container_name" "$device_id" \
      || die "refusing to resume with $container_name: ownership, device label, or image does not match fleet $FLEET_ID"
    [[ "${CONTAINER_STATE_SNAPSHOT[$container_name]}" == "running" ]] \
      || die "refusing to resume with stopped container $container_name; use --replace for a clean restart"
    retained=$((retained + 1))
    continue
  fi

  if [[ "$replace" -ne 1 ]]; then
    die "container $container_name already exists; use --resume for a staged scale-up or --replace for a clean restart"
  fi
  if snapshot_container_is_owned "$container_name" \
    || container_is_verified_legacy "$container_name" "$device_id"; then
    replacement_ids+=("${CONTAINER_ID_SNAPSHOT[$container_name]}")
    new_indexes+=("$i")
  else
    die "refusing to replace $container_name because it is not owned by fleet $FLEET_ID"
  fi
done

for container_name in "${!CONTAINER_ID_SNAPSHOT[@]}"; do
  if snapshot_container_is_owned "$container_name" \
    && [[ -z "${expected_set[$container_name]:-}" ]]; then
    die "fleet $FLEET_ID owns $container_name outside START_LIMIT=$START_LIMIT; stop the fleet before scaling down"
  fi
done

if [[ "${#replacement_ids[@]}" -gt 0 ]]; then
  remove_containers_bounded "${replacement_ids[@]}" \
    || die "failed to remove one or more verified replacement containers"
fi

start_run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
start_error_dir="$(mktemp -d "${TMPDIR:-/tmp}/gsv-demo-start.XXXXXX")"
chmod 700 "$start_error_dir"
rollback_started() {
  local exit_code=$?
  local -a run_container_ids=()
  trap - EXIT
  rm -rf -- "$start_error_dir"
  if [[ "$exit_code" -ne 0 ]]; then
    mapfile -t run_container_ids < <(start_run_container_ids "$start_run_id" 2>/dev/null || true)
    if [[ "${#run_container_ids[@]}" -gt 0 ]]; then
      warn "start stage failed; removing ${#run_container_ids[@]} containers created by run $start_run_id"
      remove_containers_bounded "${run_container_ids[@]}" \
        || warn "one or more run-owned containers could not be removed"
    fi
  fi
  exit "$exit_code"
}
trap rollback_started EXIT

start_one_device() {
  local i="$1"
  local device_id token workspace container_name
  device_id="${TOKEN_DEVICE_IDS[$i]}"
  token="${DEVICE_TOKENS[$i]}"
  workspace="$FLEET_DIR/$device_id"
  container_name="${expected_names[$i]}"

  env GSV_URL="$GSV_URL" GSV_USER="$GSV_USER" GSV_TOKEN="$token" docker run -d \
    --name "$container_name" \
    --hostname "$device_id" \
    --label "$FLEET_LABEL=true" \
    --label "$FLEET_ID_LABEL=$FLEET_ID" \
    --label "$FLEET_DEVICE_LABEL=$device_id" \
    --label "$FLEET_RUN_LABEL=$start_run_id" \
    --memory "$memory" \
    --cpus "$cpus" \
    --pids-limit "$pids_limit" \
    --log-opt "max-size=$log_size" \
    --log-opt "max-file=$log_files" \
    -e DEVICE_ID="$device_id" \
    -e GSV_URL \
    -e GSV_USER \
    -e GSV_TOKEN \
    -e GSV_DEVICE_CONSOLE_FORMAT=json \
    -v "$workspace:/fleet" \
    "$IMAGE_NAME" >/dev/null 2>"$start_error_dir/$i"
}

new_total="${#new_indexes[@]}"
echo "Starting $new_total new demo devices toward target $START_LIMIT (preserving $retained)..."
started=0
for ((batch_start = 0; batch_start < new_total; batch_start += START_PARALLELISM)); do
  batch_end=$((batch_start + START_PARALLELISM))
  ((batch_end > new_total)) && batch_end="$new_total"
  declare -a batch_pids=()
  declare -a batch_indexes=()
  for ((batch_position = batch_start; batch_position < batch_end; batch_position += 1)); do
    i="${new_indexes[$batch_position]}"
    start_one_device "$i" &
    batch_pids+=("$!")
    batch_indexes+=("$i")
  done

  batch_failures=0
  for ((batch_position = 0; batch_position < ${#batch_pids[@]}; batch_position += 1)); do
    if wait "${batch_pids[$batch_position]}"; then
      started=$((started + 1))
    else
      i="${batch_indexes[$batch_position]}"
      warn "docker run failed for ${TOKEN_DEVICE_IDS[$i]} (diagnostics suppressed to protect container environment values)"
      batch_failures=$((batch_failures + 1))
    fi
  done
  [[ "$batch_failures" -eq 0 ]] || die "$batch_failures container(s) failed in the current startup batch"
  printf '\rStarted new devices: %d/%d (target %d)' "$started" "$new_total" "$START_LIMIT"
  if [[ "$batch_end" -lt "$new_total" && "$START_BATCH_DELAY_SECONDS" -gt 0 ]]; then
    sleep "$START_BATCH_DELAY_SECONDS"
  fi
done
printf '\n'

if [[ "$wait_for_ready" -eq 0 ]]; then
  trap - EXIT
  rm -rf -- "$start_error_dir"
  echo "Target $START_LIMIT: started $started new devices and preserved $retained without waiting for gateway connections"
  exit 0
fi

deadline=$((SECONDS + wait_timeout))
connected=0
running=0
stable_samples=0
while ((SECONDS < deadline)); do
  refresh_container_inventory
  connected=0
  running=0
  declare -a running_names=()
  for ((i = 0; i < START_LIMIT; i += 1)); do
    container_name="${expected_names[$i]}"
    device_id="${TOKEN_DEVICE_IDS[$i]}"
    if snapshot_container_matches_device "$container_name" "$device_id" \
      && [[ "${CONTAINER_STATE_SNAPSHOT[$container_name]:-}" == "running" ]]; then
      running=$((running + 1))
      running_names+=("$container_name")
    fi
  done
  collect_container_connection_states "${running_names[@]}"
  for container_name in "${running_names[@]}"; do
    if [[ "${CONNECTION_STATE_BY_NAME[$container_name]:-unknown}" == "connected" ]]; then
      connected=$((connected + 1))
    fi
  done
  if [[ "$running" -eq "$START_LIMIT" && "$connected" -eq "$START_LIMIT" ]]; then
    stable_samples=$((stable_samples + 1))
    if [[ "$stable_samples" -ge "$stable_samples_required" ]]; then
      trap - EXIT
      rm -rf -- "$start_error_dir"
      printf '\n'
      echo "Fleet ready: $START_LIMIT/$START_LIMIT running and connected across $stable_samples_required checks (image $(image_revision))"
      exit 0
    fi
  else
    stable_samples=0
  fi
  printf '\rWaiting for stable connections: %d/%d running, %d/%d connected (check %d/%d)' \
    "$running" "$START_LIMIT" "$connected" "$START_LIMIT" "$stable_samples" "$stable_samples_required"
  sleep 2
done

printf '\n' >&2
echo "error: fleet did not become ready within ${wait_timeout}s ($running/$START_LIMIT running, $connected/$START_LIMIT connected)" >&2
diagnosed=0
for container_name in "${expected_names[@]}"; do
  state="${CONNECTION_STATE_BY_NAME[$container_name]:-${CONTAINER_STATE_SNAPSHOT[$container_name]:-missing}}"
  [[ "$state" == "connected" ]] && continue
  echo "--- $container_name: $state ---" >&2
  docker logs --tail 8 "$container_name" >&2 2>&1 || true
  diagnosed=$((diagnosed + 1))
  [[ "$diagnosed" -ge 10 ]] && break
done
if [[ "$((START_LIMIT - connected))" -gt "$diagnosed" ]]; then
  echo "... diagnostics limited to $diagnosed containers" >&2
fi
exit 1
