#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "usage: $0 MODEL [MODEL ...]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
package_dir="$repo_root/bench/verifiers/gsv_v1"
default_scenario="$package_dir/gsv_v1/fixtures/recover-checkout-incident.json"
scenario="${GSV_BENCH_SCENARIO:-$default_scenario}"
num_tasks="${GSV_BENCH_NUM_TASKS:-1}"
rollouts="${GSV_BENCH_ROLLOUTS:-3}"
model_concurrency="${GSV_BENCH_MODEL_CONCURRENCY:-1}"
parallel_models="${GSV_BENCH_PARALLEL_MODELS:-1}"
timeout_seconds="${GSV_BENCH_TIMEOUT_SECONDS:-900}"
max_tokens="${GSV_BENCH_MAX_TOKENS:-32768}"
reasoning_efforts_json="${GSV_BENCH_REASONING_EFFORTS_JSON:-}"
client_base_url="${GSV_BENCH_CLIENT_BASE_URL:-}"
client_api_key_var="${GSV_BENCH_CLIENT_API_KEY_VAR:-OPENAI_API_KEY}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_prefix="${GSV_BENCH_RUN_PREFIX:-matrix-$timestamp}"
matrix_dir="${GSV_BENCH_OUTPUT_DIR:-$package_dir/outputs/$run_prefix}"
if [[ "$matrix_dir" != /* ]]; then
  matrix_dir="$PWD/$matrix_dir"
fi
models=("$@")
gsv_git_commit="$(git -C "$repo_root" rev-parse HEAD)"
gsv_git_dirty=false
if [[ -n "$(git -C "$repo_root" status --short)" ]]; then
  gsv_git_dirty=true
fi
harness_source_sha256="$(
  cd "$repo_root"
  {
    find bench/runtime -type f -name '*.ts' -print0
    find bench/verifiers/gsv_v1/gsv_v1 -type f \
      \( -name '*.py' -o -name '*.json' \) -print0
    printf '%s\0' bench/scripts/run-verifiers-v1-matrix.sh
  } \
    | sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | cut -d ' ' -f 1
)"

if [[ ! -e "$scenario" ]]; then
  echo "scenario does not exist: $scenario" >&2
  exit 2
fi
for value in "$num_tasks" "$rollouts" "$model_concurrency" "$parallel_models" "$timeout_seconds"; do
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "rollout, concurrency, and timeout values must be positive integers" >&2
    exit 2
  fi
done
if [[ ! "$max_tokens" =~ ^[1-9][0-9]*$ ]]; then
  echo "GSV_BENCH_MAX_TOKENS must be a positive integer" >&2
  exit 2
fi
if [[ -n "$reasoning_efforts_json" ]]; then
  if ! jq -e '
    type == "object" and
    all(to_entries[]; (.value | type) == "string" and .value != "")
  ' <<<"$reasoning_efforts_json" >/dev/null; then
    echo "GSV_BENCH_REASONING_EFFORTS_JSON must be a JSON object of non-empty strings" >&2
    exit 2
  fi
  for model in "${models[@]}"; do
    if ! jq -e --arg model "$model" 'has($model)' \
      <<<"$reasoning_efforts_json" >/dev/null; then
      echo "GSV_BENCH_REASONING_EFFORTS_JSON has no setting for $model" >&2
      exit 2
    fi
  done
else
  reasoning_efforts_json="{}"
fi
sampling_args=(--sampling.max-tokens "$max_tokens")
client_args=()
if [[ -n "$client_base_url" ]]; then
  client_authority="${client_base_url#*://}"
  if [[ "$client_authority" != "$client_base_url" && "${client_authority%%/*}" == *@* ]]; then
    echo "GSV_BENCH_CLIENT_BASE_URL must not contain credentials" >&2
    exit 2
  fi
  if [[ ! "$client_api_key_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "GSV_BENCH_CLIENT_API_KEY_VAR must name an environment variable" >&2
    exit 2
  fi
  if [[ -z "${!client_api_key_var:-}" ]]; then
    echo "$client_api_key_var must contain a value for the custom inference endpoint" >&2
    exit 2
  fi
  client_args=(
    --client.base-url "$client_base_url"
    --client.api-key-var "$client_api_key_var"
  )
fi

mkdir -p "$matrix_dir/logs"
if [[ -d "$scenario" ]]; then
  cp -R "$scenario" "$matrix_dir/scenarios"
  frozen_scenario="$matrix_dir/scenarios"
  scenario_sha256="$(
    find "$scenario" -maxdepth 1 -type f -name '*.json' -print0 \
      | sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | cut -d ' ' -f 1
  )"
else
  cp "$scenario" "$matrix_dir/scenario.json"
  frozen_scenario="$matrix_dir/scenario.json"
  scenario_sha256="$(sha256sum "$scenario" | cut -d ' ' -f 1)"
fi
{
  printf 'scenario=%q\n' "$scenario"
  printf 'scenario_sha256=%q\n' "$scenario_sha256"
  printf 'num_tasks=%q\n' "$num_tasks"
  printf 'rollouts=%q\n' "$rollouts"
  printf 'model_concurrency=%q\n' "$model_concurrency"
  printf 'parallel_models=%q\n' "$parallel_models"
  printf 'timeout_seconds=%q\n' "$timeout_seconds"
  printf 'max_tokens=%q\n' "$max_tokens"
  printf 'reasoning_efforts_json=%q\n' "$reasoning_efforts_json"
  printf 'client_base_url=%q\n' "$client_base_url"
  printf 'client_api_key_var=%q\n' "$client_api_key_var"
  printf 'gsv_git_commit=%q\n' "$gsv_git_commit"
  printf 'gsv_git_dirty=%q\n' "$gsv_git_dirty"
  printf 'harness_source_sha256=%q\n' "$harness_source_sha256"
  printf 'models='
  printf '%q ' "${models[@]}"
  printf '\n'
} >"$matrix_dir/run.env"
models_json="$(printf '%s\n' "${models[@]}" | jq -R . | jq -s .)"
jq -n \
  --arg started_at "$timestamp" \
  --arg scenario "$scenario" \
  --arg scenario_sha256 "$scenario_sha256" \
  --arg max_tokens "$max_tokens" \
  --argjson reasoning_efforts "$reasoning_efforts_json" \
  --arg client_base_url "$client_base_url" \
  --arg client_api_key_var "$client_api_key_var" \
  --arg gsv_git_commit "$gsv_git_commit" \
  --argjson gsv_git_dirty "$gsv_git_dirty" \
  --arg harness_source_sha256 "$harness_source_sha256" \
  --argjson num_tasks "$num_tasks" \
  --argjson rollouts "$rollouts" \
  --argjson model_concurrency "$model_concurrency" \
  --argjson parallel_models "$parallel_models" \
  --argjson timeout_seconds "$timeout_seconds" \
  --argjson models "$models_json" \
  '{
    started_at: $started_at,
    scenario: $scenario,
    scenario_sha256: $scenario_sha256,
    num_tasks: $num_tasks,
    rollouts: $rollouts,
    model_concurrency: $model_concurrency,
    parallel_models: $parallel_models,
    timeout_seconds: $timeout_seconds,
    max_tokens: ($max_tokens | tonumber),
    reasoning_efforts: $reasoning_efforts,
    client: (if $client_base_url == "" then null else {
      base_url: $client_base_url,
      api_key_var: $client_api_key_var
    } end),
    models: $models,
    gsv_git_commit: $gsv_git_commit,
    gsv_git_dirty: $gsv_git_dirty,
    harness_source_sha256: $harness_source_sha256
  }' >"$matrix_dir/run.json"

pricing_tmp="$(mktemp "$matrix_dir/.pricing.XXXXXX")"
if prime --plain inference models --output json >"$pricing_tmp"; then
  mv "$pricing_tmp" "$matrix_dir/pricing.json"
else
  rm -f "$pricing_tmp"
  echo "warning: could not snapshot Prime Inference pricing" >&2
fi

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+|-+$//g'
}

run_model() {
  local model="$1"
  local slug
  local log
  local reasoning_effort
  local -a model_sampling_args
  slug="$(slugify "$model")"
  log="$matrix_dir/logs/$slug.log"
  reasoning_effort="$(
    jq -r --arg model "$model" '.[$model] // empty' \
      <<<"$reasoning_efforts_json"
  )"
  model_sampling_args=("${sampling_args[@]}")
  if [[ -n "$reasoning_effort" ]]; then
    model_sampling_args+=(--sampling.reasoning-effort "$reasoning_effort")
  fi
  echo "starting $model"
  if (
    cd "$package_dir"
    uv run eval gsv-v1 \
      --model "$model" \
      --env.agent.runtime.type subprocess \
      --env.timeout.episode "$((timeout_seconds + 120))" \
      --env.agent.timeout.rollout "$timeout_seconds" \
      --env.taskset.scenario-path "$frozen_scenario" \
      "${model_sampling_args[@]}" \
      "${client_args[@]}" \
      --no-serve --no-push --no-rich \
      --num-tasks "$num_tasks" \
      --num-rollouts "$rollouts" \
      --max-concurrent "$model_concurrency" \
      --output-dir "$matrix_dir" \
      --run.name "$slug" \
      --run.dir "$slug" \
      --clean
  ) >"$log" 2>&1; then
    echo "finished $model"
  else
    local status="$?"
    echo "failed $model (exit $status; see $log)" >&2
    return "$status"
  fi
}

failed=0
model_count="${#models[@]}"
for ((offset = 0; offset < model_count; offset += parallel_models)); do
  pids=()
  for ((index = offset; index < offset + parallel_models && index < model_count; index++)); do
    run_model "${models[$index]}" &
    pids+=("$!")
  done
  for index in "${!pids[@]}"; do
    if ! wait "${pids[$index]}"; then
      failed=1
    fi
  done
done

cd "$package_dir"
report_args=(
  "$matrix_dir"
  --scenario "$frozen_scenario"
  --output "$matrix_dir/summary.json"
)
if [[ -f "$matrix_dir/pricing.json" ]]; then
  report_args+=(--pricing "$matrix_dir/pricing.json")
fi
uv run python -m gsv_v1.report "${report_args[@]}" \
  | tee "$matrix_dir/summary.md"
if ! jq -e '.output_limit_clean == true' "$matrix_dir/summary.json" >/dev/null; then
  echo "failed validity check: one or more model responses reached the configured output limit" >&2
  failed=1
fi
uv run python -m gsv_v1.review "$matrix_dir" \
  --output "$matrix_dir/review-assignments.jsonl"
echo "matrix artifacts: $matrix_dir"
exit "$failed"
