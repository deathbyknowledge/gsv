# GSV benchmarks and RL environments

This directory contains the production-backed GSV Process surface for Prime
Intellect Verifiers v1. Verifiers owns model interception, episode concurrency,
traces, and rewards. The TypeScript runtime owns the synthetic GSV installation
and all agent-visible semantics.

Run ./bench/scripts/test-verifiers-v1.sh for a credential-free end-to-end smoke
through the real Verifiers interception endpoint.

## Runtime ownership

SyntheticKernel is one isolated GSV installation per episode. It holds Process
principals, target registrations, target ACLs, liveness, deterministic
transitions, and environment state. These axes remain independent:

- Process capabilities determine which syscall-backed tools are offered.
- Target ownership and group ACLs determine which targets a Process can see.
- Target implementations determine which routed syscalls the target accepts.
- Target liveness determines whether the target appears in the current context
  projection and can receive work.

One Kernel can hold Ship and multiple worker Processes. They share target state
but retain distinct principals, grants, roles, and context projections.
runSyntheticProcess can drive any registered Process against that shared world.
The JSON task format selects one entry Process for a Verifiers rollout; a
code-defined environment may drive additional Processes through the same API.

## Capability environments

runtime/environment.ts provides a reusable SyntheticCapabilityEnvironment plus
laptop, server, browser, and Slack factories. A scenario can configure:

- stable files for Read, Write, Edit, Delete, and Search;
- exact shell commands with deterministic output and state/file effects;
- target metadata, implementations, ownership, ACLs, and online state; and
- code-defined command maps and Kernel transitions around those environments.

Browser and Slack remain truthful capability environments: browser defaults to a
filesystem and shell-shaped profile, while Slack defaults to shell.exec for a
composable Slack CLI. Neither creates bespoke model tools. The adapter transport
projection is intentionally outside this first target-runtime batch.

The model sees only production Read, Write, Edit, Delete, Search, and Shell
schemas, Process run-control behavior, append-only messages, and ordered
[GSV EVENT] deltas. Administrative methods that connect targets, change ACLs, or
mutate synthetic state are never exposed to the model.

## Implemented tasks

1. target-appears-after-inspection starts with an authorized server offline.
   Inspecting targets applies a deterministic connection transition. Ship sees
   the production-formatted availability event, commits the requested message,
   and yields without changing its epoch prompt.
2. deploy-release-across-targets gives Ship a readable laptop and a
   shell-capable deployment server. Ship reads a release identifier from the
   laptop, routes deployment to the server, and is rewarded from the resulting
   server state. A second worker identity can see only the server.

The normalized artifact records observations, semantic events, committed
messages, target state, Process projections, and applied transitions. A task's
expected object is recursively matched as a subset of that artifact, so reward
depends on outcomes and lifecycle invariants rather than one exact action
sequence. Exact semantic logs remain available for focused conformance tests.

## Production seams and fidelity

The hot path imports production capability matching, target constants, context
projection and event formatting, syscall tool definitions, filesystem result
formatting, and Process run-control parsing/instructions. It mocks the stateful
owners behind those boundaries rather than reproducing a full Wrangler topology.

A complete Kernel and Process topology per RL episode would be too expensive and
stateful. The next fidelity layer should replay admitted fixtures through a
lower-volume Wrangler conformance oracle and compare normalized semantic logs.
Before remote Prime workers, the TypeScript runner must also be bundled and
versioned so the Python harness does not depend on a checkout and host
node_modules.

Responsibilities, delegation IPC, cancellation, stale responses, adapters,
credentials, durable storage, scheduling, media, and complete Process history
remain outside this batch. They should be added as explicit scenario-owned state
machines, not hidden inside Python reward code.
