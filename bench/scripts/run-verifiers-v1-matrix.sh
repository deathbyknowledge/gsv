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
max_tokens="${GSV_BENCH_MAX_TOKENS:-}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_prefix="${GSV_BENCH_RUN_PREFIX:-matrix-$timestamp}"
matrix_dir="${GSV_BENCH_OUTPUT_DIR:-$package_dir/outputs/$run_prefix}"
models=("$@")

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
sampling_args=()
if [[ -n "$max_tokens" ]]; then
  if [[ ! "$max_tokens" =~ ^[1-9][0-9]*$ ]]; then
    echo "GSV_BENCH_MAX_TOKENS must be a positive integer" >&2
    exit 2
  fi
  sampling_args=(--sampling.max-tokens "$max_tokens")
fi

mkdir -p "$matrix_dir/logs"
if [[ -d "$scenario" ]]; then
  cp -R "$scenario" "$matrix_dir/scenarios"
  scenario_sha256="$(
    find "$scenario" -maxdepth 1 -type f -name '*.json' -print0 \
      | sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | cut -d ' ' -f 1
  )"
else
  cp "$scenario" "$matrix_dir/scenario.json"
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
  printf 'models='
  printf '%q ' "${models[@]}"
  printf '\n'
} >"$matrix_dir/run.env"

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
  slug="$(slugify "$model")"
  log="$matrix_dir/logs/$slug.log"
  echo "starting $model"
  if (
    cd "$package_dir"
    uv run eval gsv-v1 \
      --model "$model" \
      --env.agent.runtime.type subprocess \
      --env.timeout.episode "$((timeout_seconds + 120))" \
      --env.agent.timeout.rollout "$timeout_seconds" \
      --env.taskset.scenario-path "$scenario" \
      "${sampling_args[@]}" \
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
report_args=("$matrix_dir" --output "$matrix_dir/summary.json")
if [[ -f "$matrix_dir/pricing.json" ]]; then
  report_args+=(--pricing "$matrix_dir/pricing.json")
fi
uv run python -m gsv_v1.report "${report_args[@]}" \
  | tee "$matrix_dir/summary.md"
echo "matrix artifacts: $matrix_dir"
exit "$failed"
