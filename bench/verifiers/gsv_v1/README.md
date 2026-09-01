# gsv-v1

This package is the thin Python adapter around GSV's TypeScript synthetic
installation runtime. Verifiers owns interception, traces, rollout orchestration,
and reward collection. GSV owns Process, target, responsibility, delegation,
adapter-route, context-event, and run-control semantics.

The default taskset loads every JSON scenario in gsv_v1/fixtures. Each task writes
one scenario into the isolated subprocess runtime, launches the GSV runner against
the Verifiers interception endpoint, and stores the normalized artifact in
trace.info["gsv"]. The `scenario_outcome` reward evaluates every fixture's
explicit weighted rubric against that artifact and stores the per-criterion
result in `trace.info["gsv_rubric"]`, so scoring can be recomputed offline.
Scenarios may span several durable Process runs separated by logical-time
external events. Rubrics can combine final-state subsets with semantic-event
counts and ordering constraints; they do not prescribe an exact tool trace.
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

Pass taskset.scenario-path to select one fixture or another fixture directory.

For a credential-free end-to-end smoke with a deterministic OpenAI-compatible
backend, run this from the repository root:

    ./bench/scripts/test-verifiers-v1.sh

The local package still depends on a checked-out GSV repository and installed npm
dependencies. A bundled, versioned Node runner and a Node-capable remote runtime
image are required before moving these tasks to remote Prime workers.
