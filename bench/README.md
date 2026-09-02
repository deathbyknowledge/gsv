# GSV benchmarks and RL environments

This directory contains the production-backed GSV Process surface for Prime
Intellect Verifiers v1. Verifiers owns model interception, episode concurrency,
traces, and rewards. The TypeScript runtime owns the synthetic GSV installation
and all agent-visible semantics.

Run ./bench/scripts/test-verifiers-v1.sh for a credential-free end-to-end smoke
through the real Verifiers interception endpoint.

## Reports

- [2026-09-02 stateful release-recovery evaluation](reports/2026-09-02-stateful-release-recovery-evaluation.md)
- [2026-09-02 current model evaluation](reports/2026-09-02-model-evaluation.md)

## Runtime ownership

SyntheticKernel is one isolated GSV installation per episode. It holds Process
principals, target registrations, target ACLs, liveness, deterministic
transitions, the responsibility ledger, supervised IPC calls, exact adapter
routes, and environment state. These axes remain independent:

- Process capabilities determine which syscall-backed tools are offered.
- Target ownership and group ACLs determine which targets a Process can see.
- Target implementations determine which routed syscalls the target accepts.
- Target liveness determines whether the target appears in the current context
  projection and can receive work.

One Kernel can hold Ship and multiple worker Processes. They share target state
but retain distinct principals, grants, roles, context epochs, and responsibility
visibility. A schema-v3 scenario selects one entry Process and may register
delegated agent templates. Its `components` independently compose targets,
call-triggered transitions, and scheduled events. `proc delegate` creates the child, assigns its responsibility,
runs it through the same intercepted model endpoint, and returns ordinary worker
output to its caller as an ordered GSV event.

Scenario-family documents add deterministic dataset expansion above that runtime.
A family has a base document, reusable modules, and seeded variants. Recursive
object merge plus array composition lets variants share ordinary targets and
evaluators while opting into special browser or service targets, extra Processes,
scheduled events, and additional milestones. `${variable}` substitution happens
only while materializing a variant; a placeholder occupying a complete JSON value
preserves its number, boolean, object, or array type.

## Capability environments

runtime/environment.ts provides a reusable SyntheticCapabilityEnvironment plus
laptop, server, browser, and Slack factories. `SyntheticTargetRegistry` selects
the driver declared by each target. Memory targets are deterministic; Docker Exec
and Prime Sandbox drivers let selected compatibility tasks use a real isolated
Unix environment. A scenario can configure:

- stable files for Read, Write, Edit, Delete, and Search;
- exact shell commands with deterministic output and state/file effects;
- target metadata, implementations, ownership, ACLs, and online state; and
- code-defined command maps and Kernel transitions around those environments.

Browser and Slack remain truthful capability environments: browser defaults to a
filesystem and shell-shaped profile, while a Slack target defaults to shell.exec
for a composable Slack CLI. A Slack messaging adapter is modeled separately from
that optional target. It owns ingress receipts and an idempotent outbound ledger,
while the Kernel owns the exact Process run route.

The model sees only production Read, Write, Edit, Delete, Search, and Shell
schemas, Process run-control behavior, append-only messages, and ordered
[GSV EVENT] deltas. Administrative methods that connect targets, change ACLs, or
mutate synthetic state are never exposed to the model.

Synthetic Process epochs and history survive ordinary `yield` boundaries. A
scenario may register ordered external events that advance logical time only
after a run yields and their hidden world precondition is true. Those events can
change target state, wake the same Process with an ordered GSV event, and evict
its in-memory runtime projection before the next run. The frozen prompt,
history, responsibility cursor, and target projection are reconstructed from
durable episode state.

## Implemented tasks

1. target-appears-after-inspection starts with an authorized server offline.
   Inspecting targets applies a deterministic connection transition. Ship sees
   the production-formatted availability event, commits the requested message,
   and yields without changing its epoch prompt.
2. deploy-release-across-targets gives Ship a readable laptop and a
   shell-capable deployment server. Ship reads a release identifier from the
   laptop, routes deployment to the server, and is rewarded from the resulting
   server state. A second worker identity can see only the server.
3. delegate-incident-from-slack admits an exact Slack DM route, has Ship retain
   promised work in `r12y`, delegates diagnostics to a worker that alone can read
   the incident server, returns the result over supervised IPC, resolves the
   responsibility, and sends one correlated Slack reply.
4. recover-checkout-incident gives Ship only a read-only monitor, leaves
   production authority with a discoverable operations account, and asks for an
   outcome rather than a tool sequence. The Process acknowledges the incident,
   retains it in r12y, delegates mitigation, yields across two logical health
   windows and two simulated evictions, verifies independent state, rejects
   older contradictory evidence, resolves the record, and closes the exact
   Slack thread.
5. release-recovery is a seeded family spanning four Ship runs, four distinct
   delegated Processes, three scheduled health and approval events, three
   simulated Process evictions, an exact Slack route, and optional browser
   evidence. Three variants change service, releases, timing, and evidence while
   reusing the same composable contract.

The normalized artifact records scenario family and seed, observations, semantic
events, committed messages, target state, Process projections, responsibilities,
IPC calls, adapter delivery, and applied transitions. The declarative evaluator
scores dependency-aware weighted milestones by outcome dimension, reports strict
pass separately from partial credit, and zeroes reward when a hard safety
constraint fails without discarding diagnostic raw score. Predicates support
exact or order-independent subset matching, counts, temporal ordering, and
boolean composition. Exact semantic logs remain available for focused
conformance tests.

The Terminal-Bench compatibility loader preserves an upstream instruction,
builds a sanitized context without its solution or verifier, exposes the task
machine as one GSV target, and grades with the unchanged upstream tests. It uses
local Docker when accessible and otherwise owns a private Prime image and Prime
Sandbox lifecycle. The adapter deliberately accepts only tasks whose Compose
file describes one task-root Dockerfile and no runtime semantics beyond the
standard Terminal-Bench client wrapper. Multi-service tasks and special network,
platform, tmpfs, or resource requirements fail during loading instead of being
silently evaluated in a different environment.

## Production seams and fidelity

The hot path imports production capability matching, target constants, context
projection and event formatting, responsibility baseline and transition
formatting, syscall tool definitions, filesystem result formatting, and Process
run-control parsing/instructions. It mocks the stateful owners behind those
boundaries rather than reproducing a full Wrangler topology.

A complete Kernel and Process topology per RL episode would be too expensive and
stateful. The next fidelity layer should replay admitted fixtures through a
lower-volume Wrangler conformance oracle and compare normalized semantic logs.
Before remote Verifiers workers, the TypeScript runner must also be bundled and
versioned so the Python harness does not depend on a checkout and host
node_modules.

Cancellation fencing, credentials, durable storage failure, media, complete
Process history, and provider-specific adapter retry policy remain outside this
batch. They should be added as explicit scenario-owned state machines, not
hidden inside Python reward code.
