# GSV benchmarks and RL environments

This directory contains the smallest runnable GSV Process-surface environment for
[Prime Intellect Verifiers v1](https://github.com/PrimeIntellect-ai/verifiers).
Verifiers is pinned by commit in `verifiers/gsv_v1/uv.lock` and owns model
interception, traces, rollout concurrency, and reward collection. GSV remains the
owner of agent-visible semantics.

Run `./bench/scripts/test-verifiers-v1.sh` for a credential-free end-to-end smoke
through the real Verifiers interception endpoint.

## MVP boundary

The hot-path runner in `runtime/` is not a second GSV implementation. It imports
the production Shell syscall definition, target routing projection, ordered context
event formatter, and Process run-control parser/instructions. It mocks only the
boundaries behind those surfaces:

- a fixed Process epoch prompt and initial availability projection;
- deterministic Shell results instead of a Kernel, target, or Wrangler topology;
- one scripted availability transition instead of live target discovery;
- message commit and yield persistence as a normalized semantic log.

The model observes the fixed system prompt, append-only messages, production Shell
schema, tool results, and ordered `[GSV EVENT]` deltas. Its only action is a Shell
tool call. The runner terminates on a valid `yield`, an invalid action, or the turn
limit. The Verifiers adapter places the normalized artifact in `trace.info["gsv"]`
and awards exactly `1.0` only when status is `yielded` and the semantic log exactly
matches the fixture; every other trajectory receives `0.0`. Because the reward
uses only the persisted trace, it can be recalculated offline.

Running a complete Wrangler/Kernel/Process topology for every RL rollout would be
too expensive and stateful for the training hot path. It should instead be a
lower-volume conformance oracle. Each synthetic fixture should be replayed through
that topology in CI and compared at the normalized semantic-log boundary before it
is admitted to training. The current spike enforces partial parity through shared
production functions and tests, but does not yet provide that full-topology oracle.

## First benchmark families

1. **Context epoch and run control.** Inject ordered availability or responsibility
   deltas without rewriting the epoch prompt. Reward exact event ordering, correct
   use of the newly available capability, committed user message, and explicit
   yield. The implemented `target-appears-after-inspection` task is the first case.
2. **Responsibility ownership.** Admit and revise `r12y` records, delegate work, and
   restrict child visibility to its assignments and ancestors. Reward exact ledger
   actions and successful yield only after assigned responsibilities reach a valid
   terminal/delegated state; any unauthorized view or premature yield scores zero.
3. **Cancellation and stale output.** Supersede a run while a tool or subprocess is
   pending, then release its late result. Reward preservation of queued input and a
   structurally valid history, with zero active-state mutations or committed
   messages from the stale run.

## Fidelity path

Before remote RL workers, bundle the TypeScript runner and its production seams as
a versioned artifact so the Python harness does not depend on a source checkout or
host `node_modules`. Next, add a Wrangler conformance job that runs each fixture
through the actual Process and compares normalized logs. Live target providers,
adapters, credentials, durable storage, scheduling, media, and full process history
remain outside the MVP mock and belong in that oracle or dedicated integration
families.
