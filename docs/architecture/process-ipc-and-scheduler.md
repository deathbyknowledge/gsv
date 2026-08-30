# Process IPC and Scheduler Architecture

GSV processes are durable agent processes. Each process has its own identity,
authority, execution state, queue, and history. Process-to-process communication
and scheduled work enter through Kernel-owned syscalls.

## Process model

A process owns exactly one active history. The pid names both the durable
execution boundary and that history; there is no second process-local
conversation identifier.

This keeps lifecycle state aligned:

- queued input, the active run, pending tools, and pending HIL belong to the pid;
- `proc.abort` stops the active run without deleting the process;
- `proc.reset` archives and clears the process history while preserving the pid;
- `proc.kill` archives when requested and tears down the process; and
- `proc.fork` creates a new process initialized from committed source history.

Parallel threads are therefore parallel processes. They have independent queues,
cancellation, permissions, labels, and future histories.

Each human also has one personal process. This is the default place where their
personal intelligence receives direct conversation and user-level events. The
Kernel marks the current process in its registry; the pid itself remains an
ordinary random process id. Reset keeps the same personal process, while kill
removes it and the next personal interaction creates a fresh one. Old pids are
never reused.

## Frames, events, and signals

`SignalFrame` is the existing asynchronous transport frame:

```ts
type SignalFrame<Payload = unknown> = {
  type: "sig";
  signal: string;
  payload?: Payload;
  seq?: number;
};
```

It is not itself a process signal. The terms mean:

- a notification is an outward observation such as `proc.run.stream` or
  `proc.run.finished`, often carried in a `SignalFrame`;
- a process event is ordinary work admitted through `proc.send`, IPC, an
  adapter, or the scheduler; and
- a process signal is a lifecycle operation such as abort, reset, or kill.

Runtime events stored as system records are projected into model context under
the `[GSV EVENT]` envelope. Process IPC uses identified `Delegated task from…`
or `Message from…` text rather than pretending the source was a human.

## Process IPC

`proc.ipc.send` provides asynchronous same-owner process delivery.
`proc.ipc.call` adds a bounded request with a call id and deadline. Both require a
registered source process, an existing target pid, and matching owners. The
Kernel validates those invariants and sends kernel-only `proc.ipc.deliver` to the
target Process Durable Object.

IPC acceptance is not completion. A successful send or call means the event was
started or queued by the target. A call result is delivered later to the source
process as `ipc.reply` or `ipc.timeout`.

A bounded call is a worker run rather than a human conversation. The worker returns ordinary
assistant text; it does not need `message send` or `yield`. The Process finish record
stores two independent projections:

- `result` is the durable text and media returned to the calling Process;
- `delivery` records a canonical human message, an explicit silence, or no human delivery.

The Kernel completes `proc.ipc.call` only from `result`. When the reply reaches a caller that is
already running, the Process persists the event immediately and includes it in the next model
context; if no provider request is in flight, the current loop can react without waiting for a
separate queued run.

The target pid is sufficient: IPC cannot select another history inside the
target process.

## Personal intelligence and delegation

Each human's personal agent account is the identity of their personal
intelligence: it owns the role, home, capabilities, and shared memory. One
interactive process is its current personal conversation. Web, CLI, and
unrouted private messaging surfaces resolve that process instead of selecting
the newest process or creating one per surface.

The personal marker is a stable role, not an immortal pid and not a special
kind of Process Durable Object. Killing it leaves the role temporarily empty;
the next personal entry point creates a fresh ordinary process and marks it.
Other processes may run as the same personal agent account, but they are work
with independent histories and never become the personal process by recency or
label. `proc.list` reports the distinction explicitly.

The personal agent's account home contains its role, voice, and durable memory.
Unresolved work lives in the Kernel responsibility ledger and is projected into
one immutable Process context epoch as a baseline plus ordered transitions. Each
process retains its own history and lifecycle. The personal process is the normal
user-facing place where delegated results and actionable system events return;
real child processes still use ordinary parent pids for lifecycle and IPC.

For durable delegated work, `proc delegate` creates a non-interactive child and a
supervised `proc.ipc.call`. The child inherits the personal account unless `--as ACCOUNT`
selects a specialized owned agent. The delegated-task envelope places an
inherited child in worker mode. With `--responsibility ID`, the Kernel assigns
that record to the child and persists the id on the IPC call. Completion, failure,
or explicit termination returns a still-active assignment to Ship once, with the
IPC call and child run ids recorded as evidence. The default 10-minute interval is
a supervision checkpoint, not a work deadline. At each checkpoint the Kernel renews
the pending result route, records a responsibility check-in, and tells the caller
that the child is still running without cancelling it. The result itself still re-enters the
caller as a Process event while that caller still exists; it is not copied into
the responsibility record. If the personal Process is replaced before delivery,
the Kernel returns the assignment to Ship and discards the obsolete Process
signal. The durable responsibility remains the recovery path.

During an adapter turn, `message current --json` exposes the current surface as
an opaque GSV destination id. The personal intelligence can store that id with
a commitment and use `message send --to DESTINATION --also` if a result merits a later
update. Provider account, actor, and surface identifiers remain hidden.

## History, compaction, and branching

The Process Durable Object owns active history, compaction policy, archive
segments, and generation state. Exact archived transcripts remain outside the
active model context until explicitly read or used to fork.

The public history operations are:

- `proc.history`
- `proc.history.policy.get`
- `proc.history.policy.set`
- `proc.history.compact`
- `proc.history.segments`
- `proc.history.segment.read`
- `proc.fork`

`proc.fork` is the branch operation. It snapshots only committed history; it
does not copy an active run, queued input, pending tools, or pending HIL. The
Kernel asks the source process to export the selected history, spawns a new
process with the same run-as identity and execution settings, imports the
history into that empty process, and removes temporary archive objects. A
failure rolls the child back.

`proc.history.export` and `proc.history.import` are kernel-only syscalls. They use
the normal syscall request path so branching does not create a parallel internal
API. The Durable Object methods that receive those frames are transport details,
not another semantic surface.

## Permissions

The Kernel authenticates callers and enforces process ownership at the syscall
boundary. Process-local maximum capabilities still constrain calls made by the
agent loop. Same-owner IPC is the only supported process-to-process authority
model today; cross-user process access requires an explicit ACL design.

Forking preserves the source run-as identity and does not broaden its
capabilities. The new process receives its own lifecycle and can diverge safely
after import.

## Scheduler

The scheduler is Kernel-owned. The public surface is:

- `sched.list`
- `sched.add`
- `sched.update`
- `sched.remove`
- `sched.run`

It stores definitions, calculates next fire times, enforces permissions, tracks
run history, and dispatches typed targets. Supported expressions are `at`,
`after`, `every`, and timezone-aware five-field `cron`. Supported targets are
`command.exec`, `process.spawn`, `process.event`, `responsibility`, and
`adapter.send`.

```ts
type ScheduleTarget =
  | {
      kind: "command.exec";
      command: string;
      cwd?: string;
      timeoutMs?: number;
    }
  | {
      kind: "process.spawn";
      runAs?: string;
      label?: string;
      prompt: string;
      parentPid?: string;
      cwd?: string;
    }
  | {
      kind: "process.event";
      pid: string;
      message: string;
      data?: Record<string, unknown>;
      replyTo?: AdapterMessageDestination;
    }
  | {
      kind: "responsibility";
      message: string;
      data?: Record<string, unknown>;
      priority?: "low" | "normal" | "high" | "critical";
    }
  | {
      kind: "adapter.send";
      destination: AdapterMessageDestination;
      text: string;
    };
```

Schedule success reports target dispatch, not model-run completion. A successful
`responsibility` occurrence means the Kernel durably created or recovered the
deduplicated `schedule.due` record. A successful `process.event` means the target
process admitted the transport-bound event. A successful `process.spawn` means the
new process was created and accepted its initial prompt. Child answers remain in
the child history unless another mechanism consumes them.

### Chat delivery contracts

The native shell exposes three distinct schedule forms:

```bash
sched add --ship --name NAME --after 10m --message "Give Ship this responsibility"
sched add --here --name NAME --after 10m --message "Run the agent"
sched add --to DESTINATION --name NAME --after 10m --message "Send this text"
```

`--ship` is explicit and works from top-level or process-backed shells. It creates
a `responsibility` target: every occurrence becomes one deduplicated
`schedule.due` responsibility and survives replacement of the current Ship pid.

`--here` requires a process-backed shell. It resolves to the calling process while
inside a pending IPC call. A non-Ship target remains a `process.event` target. If
the resolved target is Ship, it has the same responsibility semantics as `--ship`,
regardless of which client or adapter started the current run. It never binds
future Ship work to the current conversation route.

`--to` creates an `adapter.send` action and sends the stored text directly
without running an agent. The scheduler validates destination ownership when a
schedule is created or updated, and delivery rechecks actor and surface
authority.

## Standing responsibilities

Standing responsibility definitions describe the work GSV must continue to own.
Required contracts are always active: direct interactions must end with a Message
or explicit silence, delegated work must return to Ship on every terminal outcome,
and each enabled Ship schedule must produce its due responsibility. These rows are
Kernel-defined runtime guarantees rather than user-configurable automation.

Configurable sources are Kernel-defined producers with per-owner enablement
policies. Incoming mail, federation ingress, new contacts, new machines,
connected adapters, and adapter authentication loss are enabled by default.
Disabling a source does not discard its underlying state: the owning subsystem
still records the event, but no responsibility is created and Ship is not woken
for it.

Recurring custom responsibilities are ordinary `every` or `cron` schedules whose
target is `responsibility`. The Web responsibilities workspace presents three
projections of the same Kernel state: Open ledger records, Standing source and
recurring-schedule definitions, and terminal History. It does not create a second
automation store.

## Linux-like views

Syscalls are the source of truth. The filesystem exposes read-only views of the
same process state:

- `/proc/<pid>/ai`
- `/proc/<pid>/history`
- `/proc/<pid>/identity`
- `/proc/<pid>/segments`
- `/proc/<pid>/status`
- `/var/spool/cron`
- `/var/log/gsv/scheduler`

These paths do not introduce separate storage or lifecycle semantics.

## See also

- [The Agent Loop](./agent-loop.md)
- [Context Compaction](./context-compaction.md)
- [Syscalls Reference](../reference/syscalls.md)
