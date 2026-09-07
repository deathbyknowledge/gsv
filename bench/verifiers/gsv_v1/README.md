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

For the complete stateful family suite, run every seeded scenario 10 times from
the repository root:

    GSV_BENCH_SCENARIO="$PWD/bench/verifiers/gsv_v1/gsv_v1/families" \
    GSV_BENCH_NUM_TASKS=23 \
    GSV_BENCH_ROLLOUTS=10 \
    GSV_BENCH_MODEL_CONCURRENCY=4 \
    ./bench/scripts/run-verifiers-v1-matrix.sh MODEL [MODEL ...]

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
strict Pass@1 with a deterministic scenario-stratified bootstrap 95% interval,
unbiased Pass@3/5/10, Pass^3/5/10 reliability, family and per-scenario results,
milestones, dimensions, latency, per-Process end-to-end tok/s, aggregate tok/s at
the configured concurrency, provider-request tok/s, and listed cost. Ten trials
per scenario are the comparison protocol for the stateful suite; fewer trials
remain useful for calibration but do not produce all reliability metrics. Listed
cost is an estimate from total input (cached plus uncached) and completion tokens
at the snapshotted rates; it does not assume an unadvertised cache discount. A
leading `≥` marks known usage from a trace with an interrupted request and is a
lower bound rather than silently dropping the cost estimate.

The runner also emits `review-assignments.jsonl`, with one independent-review
assignment per rollout trajectory. Each assignment contains a concise benchmark
orientation, the complete rubric and deterministic score diagnostics, an exact
JSONL line/trace selector, a destination for the review, and a prompt that asks a
fresh reviewer for a readable timeline, score audit, root-cause classification,
and debugging implications. It also records frozen run provenance, timing, token
usage, provider failures, and the last semantic checkpoint for an interrupted
rollout. An interrupted trajectory is explicitly marked `not_scored` instead of
being presented as a zero. An orchestrator can therefore spawn one dedicated
agent per line without embedding or truncating the often-large raw trajectory;
the reviewer reads the selected source trace itself. Reviews are qualitative
debugging artifacts and never replace or mutate deterministic scores.

Assignments can also be generated or filtered after a run:

    uv run python -m gsv_v1.review MATRIX_DIR \
      --output MATRIX_DIR/review-assignments.jsonl
    uv run python -m gsv_v1.review MATRIX_DIR \
      --trajectory-id EPISODE_ID

Pass each selected assignment's `review_prompt` to a fresh agent. If it has
workspace access, it writes the Markdown review to `review_output` beneath the
matrix root; otherwise persist its returned Markdown there. Keeping one reviewer
context per rollout prevents one model's behavior or an earlier diagnosis from
biasing the explanation of another trajectory.

`GSV_BENCH_SCENARIO`, `GSV_BENCH_OUTPUT_DIR`,
`GSV_BENCH_NUM_TASKS`, `GSV_BENCH_MODEL_CONCURRENCY`, and
`GSV_BENCH_TIMEOUT_SECONDS` override the corresponding defaults.
Every matrix run explicitly sets a 32,768-token per-response output budget.
`GSV_BENCH_MAX_TOKENS` may override it for a deliberate experiment. The report
records the configured budget, counts both `finish_reason=length` responses and
responses whose usage reaches the declared ceiling, and fails the runner's
validity check if either occurs. A scenario directory can be paired with its
fixture count to run a suite. Keep the scenario set, rollout count, concurrency,
sampling profile, and timeout fixed when comparing model quality or throughput.

Set `GSV_BENCH_REASONING_EFFORTS_JSON` to a complete model-to-effort map when a
matrix must pin provider reasoning modes. If set, every requested model must
have a non-empty value; the runner passes each value as `reasoning_effort` and
records the complete map in `run.json`. For example:

    GSV_BENCH_REASONING_EFFORTS_JSON='{
      "deepseek/deepseek-v4-flash-0731": "max",
      "qwen/qwen3.8-max": "xhigh"
    }' \
      ./bench/scripts/run-verifiers-v1-matrix.sh \
        deepseek/deepseek-v4-flash-0731 qwen/qwen3.8-max

For an OpenAI-compatible server such as a locally forwarded SGLang endpoint,
set `GSV_BENCH_CLIENT_BASE_URL` and name its credential environment variable
with `GSV_BENCH_CLIENT_API_KEY_VAR` (default `OPENAI_API_KEY`). The runner checks
that the named variable exists and records its name, never its value. For a
server that ignores authentication, use a non-secret placeholder:

    OPENAI_API_KEY=local \
      GSV_BENCH_CLIENT_BASE_URL=http://127.0.0.1:30000/v1 \
      ./bench/scripts/run-verifiers-v1-matrix.sh Qwen3.8-27B

The matrix report regrades normalized artifacts offline against the frozen
scenario copy in its output directory. To audit a rubric revision without
rerunning inference, pass another fixture, directory, or family with
`python -m gsv_v1.report MATRIX_DIR --scenario SCENARIO` and preserve both
summaries and scenario digests.

For a credential-free end-to-end smoke with a deterministic OpenAI-compatible
backend, run this from the repository root:

    ./bench/scripts/test-verifiers-v1.sh

The local package still depends on a checked-out GSV repository and installed npm
dependencies. A bundled, versioned Node runner and a Node-capable remote runtime
image are required before moving these tasks to remote Prime workers.
