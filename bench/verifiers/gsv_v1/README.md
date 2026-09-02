# gsv-v1

This package is the thin Python adapter around GSV's TypeScript synthetic
installation runtime. Verifiers owns interception, traces, rollout orchestration,
and reward collection. GSV owns Process, target, responsibility, delegation,
adapter-route, context-event, and run-control semantics.

The default taskset loads every JSON scenario in gsv_v1/fixtures. Each task writes
one scenario into the isolated subprocess runtime, launches the GSV runner against
the Verifiers interception endpoint, and stores the normalized artifact in
trace.info["gsv"]. The `scenario_outcome` reward evaluates every fixture's
explicit milestones and constraints against that artifact and stores the
diagnostics in `trace.info["gsv_evaluation"]`, so scoring can be recomputed offline.
Scenarios may span several durable Process runs separated by logical-time
external events. Evaluations combine final-state subsets with semantic-event
counts, ordering, dependency gates, outcome dimensions, and hard constraints;
they do not prescribe one exact tool trace.
The normalized GSV artifact stores compact per-turn context metadata; complete
model messages remain in the Verifiers trace instead of being duplicated at
every observation.

## Local evaluation

From this directory, with an OpenAI-compatible model configured through the usual
Verifiers client flags:

    uv sync --python 3.12
    uv run eval gsv-v1 \
      --model MODEL \
      --env.agent.runtime.type subprocess \
      --no-serve --no-push \
      --num-tasks 4 --num-rollouts 1 --max-concurrent 4

Pass taskset.scenario-path to select a fixture, a directory, or a
`familySchemaVersion: 1` document. Family modules recursively compose objects and
concatenate arrays; every seeded variant becomes an independent task. For the
long-horizon release family:

    uv run eval gsv-v1 \
      --model MODEL \
      --env.agent.runtime.type subprocess \
      --env.taskset.scenario-path gsv_v1/families/release-recovery.json \
      --no-serve --no-push \
      --num-tasks 3 --num-rollouts 3 --max-concurrent 1

To run an unchanged upstream Terminal-Bench verifier through a GSV target, use
the pinned wrapper from the repository root. It selects Docker when available
and Prime Sandbox otherwise:

    ./bench/scripts/run-terminal-bench-gsv.sh MODEL

`GSV_TBENCH_TASK`, `GSV_TBENCH_BACKEND`, `GSV_TBENCH_ROLLOUTS`,
`GSV_TBENCH_MAX_TOKENS`, and `GSV_TBENCH_OUTPUT_DIR` configure that run.

To compare several served models on the same stateful scenario from the local
machine, use the matrix runner from the repository root:

    GSV_BENCH_ROLLOUTS=3 \
    GSV_BENCH_PARALLEL_MODELS=4 \
    ./bench/scripts/run-verifiers-v1-matrix.sh \
      qwen/qwen3-8b \
      qwen/qwen3-30b-a3b-instruct-2507 \
      openai/gpt-oss-120b \
      deepseek/deepseek-v3.2

By default the runner uses the stateful checkout incident, one active rollout
per model, and the Prime Inference credentials already configured by `prime
login`. It copies the exact scenario and its digest into an ignored output
directory, snapshots current model pricing, keeps a log and trace per model,
and emits `summary.md` plus a machine-readable `summary.json`. The report includes
strict Pass@1, unbiased Pass@3, Pass^3 reliability, per-scenario results,
milestones, dimensions, latency, token throughput, and listed cost. Listed cost is
an estimate from total input (cached plus uncached) and completion tokens at the
snapshotted rates; it does not assume an unadvertised cache discount.

`GSV_BENCH_SCENARIO`, `GSV_BENCH_OUTPUT_DIR`,
`GSV_BENCH_NUM_TASKS`, `GSV_BENCH_MODEL_CONCURRENCY`, and
`GSV_BENCH_TIMEOUT_SECONDS` override the corresponding defaults.
`GSV_BENCH_MAX_TOKENS` optionally sets the per-response budget for reasoning
models that otherwise spend the provider default before issuing a tool call. A scenario
directory can be paired with its fixture count to run a suite. Keep the
scenario set, rollout count, concurrency, and timeout fixed when comparing
model quality or throughput.

For a credential-free end-to-end smoke with a deterministic OpenAI-compatible
backend, run this from the repository root:

    ./bench/scripts/test-verifiers-v1.sh

The local package still depends on a checked-out GSV repository and installed npm
dependencies. A bundled, versioned Node runner and a Node-capable remote runtime
image are required before moving these tasks to remote Prime workers.
