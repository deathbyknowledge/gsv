#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
package_dir="$repo_root/bench/verifiers/gsv_v1"
fake_port="${GSV_BENCH_FAKE_PORT:-18765}"
smoke_dir="$(mktemp -d)"
fake_pid=""

cleanup() {
  if [[ -n "$fake_pid" ]]; then
    kill "$fake_pid" 2>/dev/null || true
    wait "$fake_pid" 2>/dev/null || true
  fi
  rm -rf "$smoke_dir"
}
trap cleanup EXIT

cd "$package_dir"
uv sync --python 3.12
node --import tsx "$repo_root/bench/runtime/fake-openai.ts" \
  --port "$fake_port" >"$smoke_dir/fake-openai.log" 2>&1 &
fake_pid="$!"

for _ in {1..50}; do
  if curl -fsS "http://127.0.0.1:$fake_port/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$fake_port/health" >/dev/null

GSV_BENCH_FAKE_KEY=local-test uv run eval gsv-v1 \
  --model gsv-bench-model \
  --client.base-url "http://127.0.0.1:$fake_port/v1" \
  --client.api-key-var GSV_BENCH_FAKE_KEY \
  --env.agent.runtime.type subprocess \
  --no-serve --no-push --no-rich \
  --num-tasks 1 --num-rollouts 1 --max-concurrent 1 \
  --output-dir "$smoke_dir/output" \
  --run.name gsv-local-smoke --run.dir gsv-local-smoke --clean \
  >"$smoke_dir/eval.stdout"

trace="$smoke_dir/output/gsv-local-smoke/traces.jsonl"
jq -e '.traces[0] |
  .rewards.exact_semantic_log.score == 1 and
  (.calls | length) == 2 and
  .root_reply == "gpu-lab ready" and
  .info.gsv.status == "yielded" and
  (.info.gsv.log | length) == 7 and
  (.info.gsv.observations | map(.systemPromptSha256) | unique | length) == 1
' "$trace" >/dev/null

echo "gsv Verifiers smoke passed: reward=1 calls=2 semantic_events=7"
