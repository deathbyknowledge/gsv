# gsv-v1

This package is the thin Python shell around the production-backed TypeScript GSV
Process-surface runner. Verifiers owns model interception, traces, rollout
orchestration, and rewards. The TypeScript runner owns the synthetic GSV state
transition and imports production GSV context-event, tool, and run-control
semantics.

The current vertical slice is intentionally local and deterministic. It uses the
Verifiers subprocess runtime and a checked-out GSV repository with installed npm
dependencies. A distributable runner bundle is the next step before remote RL
workers.

## Local evaluation

From this directory, with an OpenAI-compatible model endpoint configured through
the usual Verifiers client flags:

```bash
uv sync --python 3.12
uv run eval gsv-v1 \
  --model MODEL \
  --env.agent.runtime.type subprocess \
  --no-serve --no-push -n 1 -r 1 -c 1
```

The harness sends every model request to the interception endpoint and bearer
secret supplied by Verifiers. The scored artifact is stored under
`trace.info["gsv"]` so exact scoring also works offline.

For a credential-free end-to-end smoke with a deterministic OpenAI-compatible
backend, run this from the repository root:

```bash
./bench/scripts/test-verifiers-v1.sh
```
