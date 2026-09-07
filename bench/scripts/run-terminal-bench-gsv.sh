#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 MODEL" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
package_dir="$repo_root/bench/verifiers/gsv_v1"
upstream_url="${GSV_TBENCH_REPOSITORY:-https://github.com/laude-institute/terminal-bench.git}"
upstream_commit="${GSV_TBENCH_COMMIT:-d28711d0da2675d0bb1d56de45ae5df6082438a3}"
cache_parent="${GSV_TBENCH_CACHE_ROOT:-${XDG_CACHE_HOME:-${HOME:?}/.cache}/gsv/terminal-bench}"
checkout="$cache_parent/$upstream_commit"
task="${GSV_TBENCH_TASK:-fix-permissions}"
backend="${GSV_TBENCH_BACKEND:-auto}"
rollouts="${GSV_TBENCH_ROLLOUTS:-1}"
timeout_seconds="${GSV_TBENCH_TIMEOUT_SECONDS:-1800}"
max_tokens="${GSV_TBENCH_MAX_TOKENS:-}"
output_dir="${GSV_TBENCH_OUTPUT_DIR:-$package_dir/outputs/terminal-bench-$task}"
model="$1"
slug="$(printf '%s' "$model" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g')"
sampling_args=()
if [[ -n "$max_tokens" ]]; then
  if [[ ! "$max_tokens" =~ ^[1-9][0-9]*$ ]]; then
    echo "GSV_TBENCH_MAX_TOKENS must be a positive integer" >&2
    exit 2
  fi
  sampling_args=(--sampling.max-tokens "$max_tokens")
fi

if [[ ! -d "$checkout/.git" ]]; then
  mkdir -p "$cache_parent"
  git clone --filter=blob:none --no-checkout "$upstream_url" "$checkout"
  git -C "$checkout" fetch --depth 1 origin "$upstream_commit"
  git -C "$checkout" checkout --detach "$upstream_commit"
elif [[ "$(git -C "$checkout" rev-parse HEAD)" != "$upstream_commit" ]]; then
  echo "cached Terminal-Bench checkout is not at pinned commit: $checkout" >&2
  exit 2
fi

cd "$package_dir"
uv run eval gsv-v1 \
  --model "$model" \
  --env.agent.runtime.type subprocess \
  --env.timeout.episode "$((timeout_seconds + 300))" \
  --env.timeout.finalize 900 \
  --env.agent.timeout.rollout "$timeout_seconds" \
  --env.taskset.terminal-bench-path "$checkout/original-tasks" \
  --env.taskset.terminal-tasks "$task" \
  --env.taskset.terminal-backend "$backend" \
  "${sampling_args[@]}" \
  --no-serve --no-push --no-rich \
  --num-tasks 1 \
  --num-rollouts "$rollouts" \
  --max-concurrent 1 \
  --output-dir "$output_dir" \
  --run.name "$slug" \
  --run.dir "$slug" \
  --clean
