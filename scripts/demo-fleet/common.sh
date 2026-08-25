#!/usr/bin/env bash
set -euo pipefail

if ((BASH_VERSINFO[0] < 4)); then
  echo "error: demo fleet scripts require Bash 4 or newer" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

GENERATED_DIR="${DEMO_FLEET_GENERATED_DIR:-$SCRIPT_DIR/.generated}"
FLEET_DIR="${DEMO_FLEET_DIR:-$GENERATED_DIR/fleet}"
TOKENS_FILE="${DEMO_FLEET_TOKENS_FILE:-$GENERATED_DIR/tokens.csv}"
GROUND_TRUTH_FILE="${DEMO_FLEET_GROUND_TRUTH_FILE:-$GENERATED_DIR/ground-truth.json}"
IMAGE_NAME="${DEMO_FLEET_IMAGE:-gsv-demo-device:local}"
CONTAINER_PREFIX="${DEMO_FLEET_CONTAINER_PREFIX:-gsv}"
FLEET_ID="${DEMO_FLEET_ID:-default}"
DEVICE_COUNT="${DEMO_FLEET_DEVICE_COUNT:-100}"
START_LIMIT="${DEMO_FLEET_START_LIMIT:-$DEVICE_COUNT}"
START_PARALLELISM="${DEMO_FLEET_START_PARALLELISM:-25}"
START_BATCH_DELAY_SECONDS="${DEMO_FLEET_START_BATCH_DELAY_SECONDS:-1}"
CHECK_PARALLELISM="${DEMO_FLEET_CHECK_PARALLELISM:-50}"
REMOVE_PARALLELISM="${DEMO_FLEET_REMOVE_PARALLELISM:-25}"
GSV_BIN="${DEMO_FLEET_GSV_BIN:-gsv}"

FLEET_LABEL="com.gsv.demo-fleet.managed"
FLEET_ID_LABEL="com.gsv.demo-fleet.id"
FLEET_DEVICE_LABEL="com.gsv.demo-fleet.device"
FLEET_RUN_LABEL="com.gsv.demo-fleet.start-run"

die() {
  echo "error: $*" >&2
  exit 1
}

warn() {
  echo "warning: $*" >&2
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    die "$name is required but was not found in PATH"
  fi
}

require_gsv() {
  if [[ "$GSV_BIN" == */* ]]; then
    [[ -x "$GSV_BIN" ]] || die "GSV CLI is not executable: $GSV_BIN"
  else
    require_command "$GSV_BIN"
  fi
}

validate_integer() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"
  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be an integer from $minimum to $maximum"
  ((10#$value >= minimum && 10#$value <= maximum)) \
    || die "$name must be an integer from $minimum to $maximum"
}

validate_common_config() {
  validate_integer "DEMO_FLEET_DEVICE_COUNT" "$DEVICE_COUNT" 1 1000
  validate_integer "DEMO_FLEET_START_LIMIT" "$START_LIMIT" 1 "$DEVICE_COUNT"
  validate_integer "DEMO_FLEET_START_PARALLELISM" "$START_PARALLELISM" 1 100
  validate_integer "DEMO_FLEET_START_BATCH_DELAY_SECONDS" "$START_BATCH_DELAY_SECONDS" 0 30
  validate_integer "DEMO_FLEET_CHECK_PARALLELISM" "$CHECK_PARALLELISM" 1 200
  validate_integer "DEMO_FLEET_REMOVE_PARALLELISM" "$REMOVE_PARALLELISM" 1 100
  [[ "$CONTAINER_PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
    || die "DEMO_FLEET_CONTAINER_PREFIX contains invalid Docker name characters"
  [[ "$FLEET_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]] \
    || die "DEMO_FLEET_ID must be 1-63 letters, digits, dots, underscores, or hyphens"
  [[ "$FLEET_DIR" != "/" && "$FLEET_DIR" != "$ROOT_DIR" && "$FLEET_DIR" != "$SCRIPT_DIR" ]] \
    || die "unsafe DEMO_FLEET_DIR: $FLEET_DIR"
  [[ "$GENERATED_DIR" != "/" && "$GENERATED_DIR" != "$ROOT_DIR" && "$GENERATED_DIR" != "$SCRIPT_DIR" ]] \
    || die "unsafe DEMO_FLEET_GENERATED_DIR: $GENERATED_DIR"
}

validate_gateway_inputs() {
  [[ -n "${GSV_URL:-}" ]] || die "GSV_URL is required"
  [[ "$GSV_URL" == ws://* || "$GSV_URL" == wss://* ]] \
    || die "GSV_URL must begin with ws:// or wss://"
  [[ "$GSV_URL" != *$'\n'* && "$GSV_URL" != *$'\r'* ]] || die "GSV_URL contains a newline"
  [[ -n "${GSV_USER:-}" ]] || die "GSV_USER is required"
  [[ "$GSV_USER" != *$'\n'* && "$GSV_USER" != *$'\r'* ]] || die "GSV_USER contains a newline"
}

require_docker() {
  require_command docker
  docker info >/dev/null 2>&1 || die "Docker is installed but its daemon is unavailable"
}

run_gsv_user() {
  if [[ -n "${GSV_USER_TOKEN:-}" ]]; then
    env GSV_TOKEN="$GSV_USER_TOKEN" "$GSV_BIN" --url "$GSV_URL" -u "$GSV_USER" "$@"
  else
    env -u GSV_TOKEN "$GSV_BIN" --url "$GSV_URL" -u "$GSV_USER" "$@"
  fi
}

device_id_for_index() {
  printf "edge-%03d" "$1"
}

is_canonical_device_id() {
  local device_id="$1"
  local suffix
  [[ "$device_id" == edge-* ]] || return 1
  suffix="${device_id#edge-}"
  if [[ "$suffix" =~ ^[0-9]{3}$ ]]; then
    ((10#$suffix >= 1))
    return
  fi
  [[ "$suffix" == "1000" ]]
}

container_name_for_device() {
  local device_id="$1"
  printf "%s-%s" "$CONTAINER_PREFIX" "$device_id"
}

validate_workspaces() {
  local count="${1:-$DEVICE_COUNT}"
  local i device_id
  [[ -d "$FLEET_DIR" ]] || die "missing fleet directory $FLEET_DIR; seed the fleet first"
  for ((i = 1; i <= count; i += 1)); do
    device_id="$(device_id_for_index "$i")"
    [[ -d "$FLEET_DIR/$device_id" ]] || die "missing workspace $FLEET_DIR/$device_id"
  done
}

# Loads and validates the complete CSV into TOKEN_* arrays. Tokens are never printed.
load_device_tokens() {
  local header line device_id token_id token extra expected line_number=1
  declare -g -a TOKEN_DEVICE_IDS=()
  declare -g -a TOKEN_IDS=()
  declare -g -a DEVICE_TOKENS=()
  declare -A seen_devices=()
  declare -A seen_ids=()

  [[ -f "$TOKENS_FILE" && ! -L "$TOKENS_FILE" ]] \
    || die "missing token file $TOKENS_FILE; run create-device-tokens.sh first"
  chmod 600 "$TOKENS_FILE"
  IFS= read -r header < "$TOKENS_FILE" || die "could not read $TOKENS_FILE"
  [[ "${header%$'\r'}" == "device_id,token_id,token" ]] || die "invalid token CSV header in $TOKENS_FILE"

  while IFS=, read -r device_id token_id token extra; do
    line_number=$((line_number + 1))
    token="${token%$'\r'}"
    [[ -n "$device_id" && -n "$token_id" && -n "$token" && -z "${extra:-}" ]] \
      || die "invalid token row at $TOKENS_FILE:$line_number"
    [[ -z "${seen_devices[$device_id]:-}" ]] || die "duplicate device id in token CSV: $device_id"
    [[ -z "${seen_ids[$token_id]:-}" ]] || die "duplicate token id in token CSV: $token_id"
    seen_devices[$device_id]=1
    seen_ids[$token_id]=1
    TOKEN_DEVICE_IDS+=("$device_id")
    TOKEN_IDS+=("$token_id")
    DEVICE_TOKENS+=("$token")
  done < <(tail -n +2 "$TOKENS_FILE")

  [[ "${#TOKEN_DEVICE_IDS[@]}" -eq "$DEVICE_COUNT" ]] \
    || die "$TOKENS_FILE has ${#TOKEN_DEVICE_IDS[@]} token rows; expected $DEVICE_COUNT"
  for ((line_number = 1; line_number <= DEVICE_COUNT; line_number += 1)); do
    expected="$(device_id_for_index "$line_number")"
    [[ "${TOKEN_DEVICE_IDS[$((line_number - 1))]}" == "$expected" ]] \
      || die "token row $line_number names ${TOKEN_DEVICE_IDS[$((line_number - 1))]}; expected $expected"
  done
}

# Captures container identity and ownership in one Docker call. Callers use the
# immutable IDs for deletion so a concurrently reused name cannot be removed.
refresh_container_inventory() {
  local id name state image managed fleet_id device_id start_run
  declare -g -A CONTAINER_ID_SNAPSHOT=()
  declare -g -A CONTAINER_STATE_SNAPSHOT=()
  declare -g -A CONTAINER_IMAGE_SNAPSHOT=()
  declare -g -A CONTAINER_MANAGED_SNAPSHOT=()
  declare -g -A CONTAINER_FLEET_ID_SNAPSHOT=()
  declare -g -A CONTAINER_DEVICE_ID_SNAPSHOT=()
  declare -g -A CONTAINER_START_RUN_SNAPSHOT=()

  while IFS='|' read -r id name state image managed fleet_id device_id start_run; do
    [[ -n "$id" && -n "$name" ]] || continue
    CONTAINER_ID_SNAPSHOT[$name]="$id"
    CONTAINER_STATE_SNAPSHOT[$name]="$state"
    CONTAINER_IMAGE_SNAPSHOT[$name]="$image"
    CONTAINER_MANAGED_SNAPSHOT[$name]="$managed"
    CONTAINER_FLEET_ID_SNAPSHOT[$name]="$fleet_id"
    CONTAINER_DEVICE_ID_SNAPSHOT[$name]="$device_id"
    CONTAINER_START_RUN_SNAPSHOT[$name]="$start_run"
  done < <(docker ps -a --no-trunc --format \
    "{{.ID}}|{{.Names}}|{{.State}}|{{.Image}}|{{.Label \"$FLEET_LABEL\"}}|{{.Label \"$FLEET_ID_LABEL\"}}|{{.Label \"$FLEET_DEVICE_LABEL\"}}|{{.Label \"$FLEET_RUN_LABEL\"}}")
}

snapshot_container_is_owned() {
  local name="$1"
  [[ "${CONTAINER_MANAGED_SNAPSHOT[$name]:-}" == "true" \
    && "${CONTAINER_FLEET_ID_SNAPSHOT[$name]:-}" == "$FLEET_ID" ]]
}

snapshot_container_matches_device() {
  local name="$1"
  local device_id="$2"
  snapshot_container_is_owned "$name" \
    && [[ "${CONTAINER_DEVICE_ID_SNAPSHOT[$name]:-}" == "$device_id" \
      && "${CONTAINER_IMAGE_SNAPSHOT[$name]:-}" == "$IMAGE_NAME" ]]
}

owned_container_ids() {
  docker ps -aq --no-trunc \
    --filter "label=$FLEET_LABEL=true" \
    --filter "label=$FLEET_ID_LABEL=$FLEET_ID"
}

start_run_container_ids() {
  local start_run="$1"
  docker ps -aq --no-trunc \
    --filter "label=$FLEET_LABEL=true" \
    --filter "label=$FLEET_ID_LABEL=$FLEET_ID" \
    --filter "label=$FLEET_RUN_LABEL=$start_run"
}

# Removes pre-verified immutable container IDs with bounded Docker concurrency.
remove_containers_bounded() {
  local -a refs=("$@")
  local -a pids=()
  local failures=0
  local ref pid

  for ref in "${refs[@]}"; do
    docker rm -f "$ref" >/dev/null &
    pids+=("$!")
    if [[ "${#pids[@]}" -ge "$REMOVE_PARALLELISM" ]]; then
      for pid in "${pids[@]}"; do
        if ! wait "$pid"; then
          failures=$((failures + 1))
        fi
      done
      pids=()
    fi
  done
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      failures=$((failures + 1))
    fi
  done
  [[ "$failures" -eq 0 ]]
}

container_label() {
  local name="$1"
  local label="$2"
  docker container inspect "$name" --format "{{with index .Config.Labels \"$label\"}}{{.}}{{end}}" 2>/dev/null
}

container_is_verified_legacy() {
  local name="$1"
  local device_id="$2"
  local image mount_source expected_source
  [[ "$name" == "$(container_name_for_device "$device_id")" ]] || return 1
  [[ -z "$(container_label "$name" "$FLEET_LABEL")" ]] || return 1
  image="$(docker container inspect "$name" --format '{{.Config.Image}}' 2>/dev/null)" || return 1
  [[ "$image" == "$IMAGE_NAME" ]] || return 1
  docker container inspect "$name" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep -Fqx "DEVICE_ID=$device_id" || return 1
  mount_source="$(docker container inspect "$name" --format '{{range .Mounts}}{{if eq .Destination "/fleet"}}{{println .Source}}{{end}}{{end}}' 2>/dev/null)"
  expected_source="$(cd "$FLEET_DIR/$device_id" 2>/dev/null && pwd -P)" || return 1
  [[ "${mount_source%$'\n'}" == "$expected_source" ]]
}

verified_legacy_container_ids() {
  local name device_id
  refresh_container_inventory
  for name in "${!CONTAINER_ID_SNAPSHOT[@]}"; do
    [[ "$name" == "$CONTAINER_PREFIX-edge-"* ]] || continue
    device_id="${name#"$CONTAINER_PREFIX-"}"
    is_canonical_device_id "$device_id" || continue
    [[ -z "${CONTAINER_MANAGED_SNAPSHOT[$name]:-}" ]] || continue
    if container_is_verified_legacy "$name" "$device_id"; then
      printf '%s\n' "${CONTAINER_ID_SNAPSHOT[$name]}"
    fi
  done
}

container_is_running() {
  [[ "$(docker container inspect "$1" --format '{{.State.Running}}' 2>/dev/null)" == "true" ]]
}

connection_state_since() {
  local name="$1"
  local started_at="$2"
  docker logs --since "$started_at" "$name" 2>&1 | awk '
    /"event"[[:space:]]*:[[:space:]]*"connect\.ok"/ { state = "connected"; next }
    /"event"[[:space:]]*:[[:space:]]*"connect\.(attempt|lost|failed|timeout|setup_required)"/ { state = "connecting"; next }
    /"event"[[:space:]]*:[[:space:]]*"keepalive\.(request_error|timeout)"/ { state = "connecting"; next }
    END { print state == "" ? "connecting" : state }
  '
}

# A container is connected only when its latest relevant event since the current
# Docker start is connect.ok. This excludes retained logs from earlier starts.
container_connection_state() {
  local name="$1"
  local started_at
  if ! container_is_running "$name"; then
    printf 'stopped\n'
    return
  fi
  started_at="$(docker container inspect "$name" --format '{{.State.StartedAt}}' 2>/dev/null)" || {
    printf 'unknown\n'
    return
  }
  connection_state_since "$name" "$started_at"
}

_write_container_connection_state() {
  local name="$1"
  local started_at="$2"
  local output_file="$3"
  local state
  state="$(connection_state_since "$name" "$started_at" 2>/dev/null || printf 'unknown\n')"
  case "$state" in
    connected|connecting|stopped|unknown) ;;
    *) state="unknown" ;;
  esac
  printf '%s\n' "$state" > "$output_file"
}

# Populates CONNECTION_STATE_BY_NAME while bounding per-container inspect/log
# calls. Each result is written separately so concurrent workers share no state.
collect_container_connection_states() {
  local -a names=("$@")
  local -a pids=()
  local tmp_dir index pid state name running started_at
  declare -A started_by_name=()
  declare -g -A CONNECTION_STATE_BY_NAME=()
  [[ "${#names[@]}" -gt 0 ]] || return 0

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/gsv-demo-connections.XXXXXX")"
  chmod 700 "$tmp_dir"
  while IFS='|' read -r name running started_at; do
    name="${name#/}"
    [[ -n "$name" && "$running" == "true" && -n "$started_at" ]] || continue
    started_by_name[$name]="$started_at"
  done < <(docker container inspect \
    --format '{{.Name}}|{{.State.Running}}|{{.State.StartedAt}}' \
    "${names[@]}" 2>/dev/null || true)

  for ((index = 0; index < ${#names[@]}; index += 1)); do
    name="${names[$index]}"
    started_at="${started_by_name[$name]:-}"
    if [[ -z "$started_at" ]]; then
      printf 'unknown\n' > "$tmp_dir/$index"
      continue
    fi
    _write_container_connection_state "$name" "$started_at" "$tmp_dir/$index" &
    pids+=("$!")
    if [[ "${#pids[@]}" -ge "$CHECK_PARALLELISM" ]]; then
      for pid in "${pids[@]}"; do
        wait "$pid" || true
      done
      pids=()
    fi
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done

  for ((index = 0; index < ${#names[@]}; index += 1)); do
    state="unknown"
    if [[ -f "$tmp_dir/$index" ]]; then
      IFS= read -r state < "$tmp_dir/$index" || state="unknown"
    fi
    CONNECTION_STATE_BY_NAME["${names[$index]}"]="$state"
  done
  rm -rf -- "$tmp_dir"
}

image_revision() {
  docker image inspect "$IMAGE_NAME" \
    --format '{{with index .Config.Labels "org.opencontainers.image.revision"}}{{.}}{{else}}unknown{{end}}' \
    2>/dev/null || printf 'missing\n'
}
