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
  --num-tasks 4 --num-rollouts 1 --max-concurrent 4 \
  --output-dir "$smoke_dir/output" \
  --run.name gsv-local-smoke --run.dir gsv-local-smoke --clean \
  >"$smoke_dir/eval.stdout"

GSV_BENCH_FAKE_KEY=local-test uv run eval gsv-v1 \
  --model gsv-bench-model \
  --client.base-url "http://127.0.0.1:$fake_port/v1" \
  --client.api-key-var GSV_BENCH_FAKE_KEY \
  --env.agent.runtime.type subprocess \
  --env.taskset.scenario-path "$package_dir/gsv_v1/families/release-recovery.json" \
  --no-serve --no-push --no-rich \
  --num-tasks 1 --num-rollouts 1 --max-concurrent 1 \
  --output-dir "$smoke_dir/family-output" \
  --run.name gsv-family-smoke --run.dir gsv-family-smoke --clean \
  >"$smoke_dir/family-eval.stdout"

for family_spec in "competing-incidents:10" "service-account-operation:10"; do
  family="${family_spec%%:*}"
  task_count="${family_spec##*:}"
  GSV_BENCH_FAKE_KEY=local-test uv run eval gsv-v1 \
    --model gsv-bench-model \
    --client.base-url "http://127.0.0.1:$fake_port/v1" \
    --client.api-key-var GSV_BENCH_FAKE_KEY \
    --env.agent.runtime.type subprocess \
    --env.taskset.scenario-path "$package_dir/gsv_v1/families/$family.json" \
    --no-serve --no-push --no-rich \
    --num-tasks "$task_count" --num-rollouts 1 --max-concurrent "$task_count" \
    --output-dir "$smoke_dir/$family-output" \
    --run.name "$family-smoke" --run.dir "$family-smoke" --clean \
    >"$smoke_dir/$family-eval.stdout"
done

trace="$smoke_dir/output/gsv-local-smoke/traces.jsonl"
jq -s -e '
  length == 4 and
  all(.[];
    (.traces | length) == 1 and
    .traces[0].rewards.scenario_outcome.score == 1 and
    .traces[0].info.gsv.status == "yielded" and
    (.traces[0].info.gsv.observations
      | group_by(.processId)
      | all(.[]; (map(.systemPromptSha256) | unique | length) == 1)) and
    .traces[0].info.gsv_evaluation.strict_pass == true and
    all(.traces[0].info.gsv_evaluation.milestones[]; .passed == true) and
    all(.traces[0].info.gsv_evaluation.constraints[]; .passed == true)
  ) and
  ([.[].traces[0].info.gsv.scenarioId] | sort) == [
    "delegate-incident-from-slack",
    "deploy-release-across-targets",
    "recover-checkout-incident",
    "target-appears-after-inspection"
  ] and
  ([.[].traces[0].root_reply] | sort) == [
    "Checkout is stable on checkout-2026.08.31 after rollback; two healthy monitor windows confirmed.",
    "checkout blocked: database migration checksum mismatch",
    "gpu-lab ready",
    "release deployed"
  ] and
  ([.[].traces[0].calls | length] | add) == 32
' "$trace" >/dev/null

family_trace="$smoke_dir/family-output/gsv-family-smoke/traces.jsonl"
jq -s -e '
  length == 1 and
  .[0].ok == true and
  .[0].traces[0].rewards.scenario_outcome.score == 1 and
  .[0].traces[0].info.gsv.status == "yielded" and
  .[0].traces[0].info.gsv.scenarioId == "release-recovery:checkout-schema" and
  .[0].traces[0].info.gsv.scenarioFamily == "release-recovery" and
  .[0].traces[0].info.gsv_evaluation.strict_pass == true and
  all(.[0].traces[0].info.gsv_evaluation.milestones[]; .passed == true) and
  all(.[0].traces[0].info.gsv_evaluation.constraints[]; .passed == true) and
  (.[0].traces[0].info.gsv.world.delegations | length) == 4 and
  (.[0].traces[0].info.gsv.world.externalEvents | map(.state) | unique) == ["applied"]
' "$family_trace" >/dev/null

for family_spec in "competing-incidents:10" "service-account-operation:10"; do
  family="${family_spec%%:*}"
  task_count="${family_spec##*:}"
  family_trace="$smoke_dir/$family-output/$family-smoke/traces.jsonl"
  jq -s -e \
    --arg family "$family" \
    --argjson task_count "$task_count" '
      length == $task_count and
      all(.[].traces[0];
        .rewards.scenario_outcome.score == 1 and
        .info.gsv.status == "yielded" and
        .info.gsv.scenarioFamily == $family and
        .info.gsv_evaluation.strict_pass == true and
        all(.info.gsv_evaluation.milestones[]; .passed == true) and
        all(.info.gsv_evaluation.constraints[]; .passed == true) and
        (.info.gsv.world.externalEvents | map(.state) | unique) == ["applied"]
      )
    ' "$family_trace" >/dev/null
done

echo "gsv Verifiers smoke passed: fixtures=4 release=1 competing=10 service-account=10 rewards=1"
