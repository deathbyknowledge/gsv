# Process IPC and Scheduler Design

This document captures the planned direction for process-to-process
communication, multi-conversation processes, and scheduled work in GSV.

The goal is to make the implementation feel like the rest of GSV: Linux-like in
mental model, explicit about authority, and structured enough for agents and
humans to reason about.

## Design Intent

GSV processes should be durable agent instances, not single chat sessions. A
process may have an owner, a workspace, mounted context, package source, tools,
and process-local state. Multiple users, apps, adapters, schedules, or other
processes may need to interact with that same process over time.

The model should therefore distinguish:

- A process: the durable agent instance and authority boundary.
- A conversation: an attachable dialogue or interaction stream with a process.
- An event: normal work or content delivered to a process.
- A process signal: control-plane operation such as abort, kill, reset, pause,
  resume, or reload.
- A transport frame: the envelope used to move requests, responses, and async
  push messages across WebSocket, service binding, app bridge, or process
  boundaries.
- A scheduler: Kernel-owned cron/timer service that dispatches typed work under
  an explicit principal.

This keeps the OS analogy clear. A GSV process is closer to a daemon than a
single terminal session. Conversations are attachments to that daemon. Events
are ordinary input. Process signals control the daemon. Frames are only the
transport.

## Naming Rules

The existing protocol has a `SignalFrame`:

```ts
type SignalFrame<Payload = unknown> = {
  type: "sig";
  signal: string;
  payload?: Payload;
  seq?: number;
};
```

That name should not be changed for now. It is the existing async push frame on
the wire, and compatibility matters.

Architecturally, however, it should be treated as a transport-level push frame,
not as proof that every payload it carries is a process signal.

Use these meanings:

- `SignalFrame`: existing transport frame with `type: "sig"` and a `signal`
  topic string.
- Notification: an outward observation such as `chat.delta`, `chat.complete`,
  `device.status`, `exec.status`, or `identity.changed`, often carried over a
  `SignalFrame`.
- Process event: normal input/work delivered to a process conversation or inbox.
- Process signal: process control operation such as abort, kill, reset, pause,
  resume, or reload.

In short: a `SignalFrame` is a frame kind; a process signal is a runtime
semantic.

## Process Conversations

Each process should support one or more conversations.

A conversation is the process-local unit for:

- message history
- queued incoming events
- participants
- surface routing
- HIL state
- run state
- narrowed context/tool policy

Existing processes and existing callers should continue to work through a
default conversation. Current calls such as `proc.send` and `proc.history` can
gain an optional `conversationId` while preserving the current behavior when it
is omitted.

The first implementation should remain process-serial: a process may have many
conversations, but only one active agent run at a time. Per-conversation or
parallel execution can be added later after state isolation is mature.

Future process concurrency can be modeled explicitly:

```ts
type ProcessConcurrency =
  | { mode: "serial" }
  | { mode: "per-conversation"; maxRuns?: number }
  | { mode: "parallel"; maxRuns: number };
```

The default should be `serial`.

## Process Events

Content-bearing input should enter a process as a typed event, not as an
untyped chat string.

Example shape:

```ts
type ProcessEvent = {
  id: string;
  source: ProcessPrincipal;
  target: {
    pid: string;
    conversationId?: string;
    port?: string;
  };
  kind:
    | "user.message"
    | "adapter.message"
    | "process.message"
    | "process.call"
    | "schedule.tick"
    | "package.event"
    | "hil.reply";
  payload: unknown;
  traceId?: string;
  replyTo?: EventReplyTarget;
  createdAtMs: number;
};
```

Some events may be rendered into conversation history. Others may be handled as
structured input. The runtime should not have to pretend that every inbound
thing is a user message.

When a runtime event is rendered into model context, it should be visibly marked
as such. The current convention is a conversation message that starts with
`[Process Event]:`. Profile context teaches agents that these entries are GSV
runtime events such as IPC replies, IPC timeouts, watched signals, compaction
summaries, resets, or other process lifecycle changes.

## IPC Primitives

The process syscall surface should grow in layers.

Compatibility extensions:

- `proc.send`: optional `conversationId`; maps to a process event.
- `proc.history`: optional `conversationId`.
- `proc.abort`: optionally scoped to a conversation/run where possible.
- `proc.reset`: should define whether it resets one conversation or the whole
  process.

Conversation syscalls:

- `proc.conversation.open`
- `proc.conversation.list`
- `proc.conversation.get`
- `proc.conversation.close`

Process-to-process syscalls:

- `proc.mail`: async process-to-process delivery with no immediate response.
- `proc.call`: request/response delivery with timeout and bounded result.
- `proc.delegate`: higher-level helper for bounded task delegation.

The first version should support same-owner communication only. Cross-user
conversation and IPC should wait until process ACLs and context/tool narrowing
are explicit.

## Conversation Compaction and Reset

Compaction and reset should be first-class conversation lifecycle operations,
not hidden automation.

The Linux-like model is log rotation plus checkpointing:

- A conversation has an active working log.
- Compaction rotates an old prefix of that log into an archive segment, writes a
  visible summary, and keeps the conversation id.
- Reset rotates the active log into an archive segment and starts a new
  generation for the same conversation or a new conversation, depending on the
  requested mode.
- Checkpointing writes durable continuity artifacts for workspace-backed
  processes.

This keeps all history movement inspectable. No transcript should disappear into
an unmodeled background flow.

### Conversation generations and segments

A conversation should track an active generation. Reset increments the
generation. Compaction creates archive segments inside a generation.

Possible storage concepts:

```ts
type ConversationGeneration = {
  pid: string;
  conversationId: string;
  generation: number;
  createdAtMs: number;
  reason?: string;
};

type ConversationSegment = {
  id: string;
  pid: string;
  conversationId: string;
  generation: number;
  kind: "compaction" | "reset" | "checkpoint";
  fromMessageId: number;
  toMessageId: number;
  archiveUri: string;
  summaryMessageId?: number;
  summaryUri?: string;
  reason?: string;
  createdAtMs: number;
};
```

Message, queue, pending tool call, HIL, and run records should carry the
conversation id and generation. Late results from an old generation must not
mutate the active generation.

### Compact

Compaction is lossy for the active model context but should be lossless for raw
storage.

A compact operation should:

1. Require the conversation to be idle, or queue until the active run completes.
2. Select an old prefix of active messages.
3. Archive the exact selected messages as JSONL, compressed where appropriate.
4. Accept a markdown summary.
5. Replace the selected active messages with one explicit summary/system record.
6. Record a `ConversationSegment`.
7. Later, emit a notification topic over the existing `SignalFrame` transport, for
   example `conversation.compacted`.

The summary record should say what happened and where the exact archive lives.
Agents should be able to inspect the archive through normal history or
filesystem surfaces.

Compaction should be callable explicitly:

- `proc.conversation.compact`
- `proc.conversation.segments`

It may also run automatically under a visible conversation policy, but that
policy must be part of process/conversation state.

Example policy:

```ts
type ConversationContextPolicy = {
  overflow: "manual" | "auto-compact" | "auto-reset" | "fail";
  compactAtTokens?: number;
  keepRecentTokens?: number;
  archiveExactTranscript: boolean;
};
```

Automatic compaction is acceptable when it is policy-driven, recorded, and
visible. It should not be a secret background subsystem.

### Reset

Reset is an explicit boundary. It should archive the active generation, clear
active run state, and start fresh.

Reset should be callable explicitly:

- `proc.conversation.reset`

Reset options should define whether to:

- archive exact transcript
- carry forward a generated summary
- clear summary and start empty
- reset only one conversation
- reset the whole process

The default should preserve the exact transcript in archive storage. Carrying a
summary forward should be explicit, because a reset often means "forget the
working conversation."

Process-wide reset archives each non-empty conversation as its own generation
file under one archive directory:

```text
/var/sessions/<username>/<pid>/<archiveId>/
  default.gen-1.jsonl.gz
  build.gen-3.jsonl.gz
```

### Checkpoint

Checkpointing should be distinct from compaction and reset.

Compaction manages the active model working set. Reset creates a conversation
boundary. Checkpointing writes durable continuity artifacts, especially for
workspace-backed processes.

Workspace-backed checkpoints may update files such as:

- `.gsv/summary.md`
- `.gsv/processes/<pid>/conversations/<conversationId>/chat.jsonl`
- `.gsv/processes/<pid>/conversations/<conversationId>/segments.jsonl`

Those paths should be generated from explicit lifecycle operations, not from a
separate automation system.

### History access

The ordinary history API should remain convenient for active history:

- `proc.history`

It should grow options for archived or segmented history:

- active generation only
- include summary markers
- include archived segment metadata
- read a specific segment
- read a specific generation

Exact archived transcript access should be explicit so normal model context does
not accidentally reload old bulk history.

## Permissions

A process owner is not enough to define conversation authority.

A process has maximum capabilities. A conversation narrows what a participant
can see and do. This prevents guest users, packages, adapters, or other
processes from implicitly gaining access to the owner's private context or tool
surface.

Conversation ACLs should eventually cover:

- `converse`
- `read_history`
- `send_event`
- `signal`
- `manage`
- `schedule`

Conversation policy should also cover context and tools:

```ts
type ConversationPolicy = {
  context: "owner-private" | "shared" | "guest";
  tools: {
    allowedCaps: string[];
  };
};
```

Cross-user access should default to restricted context and restricted tools.
Owner-private home context should not leak into guest conversations unless the
owner explicitly allows it.

## Scheduler

The previous Kernel automation path has been removed. The old archivist/curator
mechanism is not the desired scheduler foundation.

The existing `sched.*` syscall names should become the public scheduler surface:

- `sched.list`
- `sched.add`
- `sched.update`
- `sched.remove`
- `sched.run`

The scheduler should be Kernel-owned. It should store schedule definitions,
calculate next fire times, run due work, enforce permissions, track run history,
and dispatch typed targets.

Schedule records should include:

- id
- owner uid
- creator principal
- run-as principal
- name and description
- enabled state
- schedule expression
- target
- overlap policy
- misfire policy
- retry policy
- created/updated timestamps
- last and next run state

Example target shape:

```ts
type ScheduleTarget =
  | {
      kind: "process.spawn";
      profile: string;
      prompt: string;
      workspace?: unknown;
    }
  | {
      kind: "process.event";
      pid: string;
      conversationId?: string;
      event: ProcessEventInput;
    }
  | {
      kind: "process.lifecycle";
      pid: string;
      conversationId?: string;
      action: "compact" | "reset" | "checkpoint";
      options?: unknown;
    }
  | {
      kind: "package.event";
      packageId: string;
      entrypoint: string;
      event: string;
      payload?: unknown;
    };
```

The first implementation should support:

- `at`
- `every`
- `process.spawn`
- `process.event`
- `process.lifecycle` for compact, reset, and checkpoint

Cron expressions, package events, advanced retry behavior, and cross-user run-as
rules can follow after the basic lifecycle is working.

## Linux-Like Views

The structured syscall/API model should be the source of truth. Filesystem views
can make the system legible to users and agents.

Potential views:

- `/proc/<pid>/conversations`
- `/proc/<pid>/conversations/<conversationId>`
- `/proc/<pid>/conversations/<conversationId>/history`
- `/proc/<pid>/conversations/<conversationId>/segments`
- `/var/spool/cron`
- `/var/log/gsv/scheduler`

These should be views over Kernel and Process state, not separate stores.

## Implementation Plan

### 1. Remove old automation

Completed initial cleanup:

- removed `gateway/src/kernel/automation.ts`
- removed `AutomationStore` wiring from the Kernel
- removed archivist/curator scheduling and dispatch from `gateway/src/kernel/do.ts`
- removed archivist/curator default profile config
- removed archivist/curator profile list entries

Keep the existing `SignalFrame` protocol and `signal.watch` behavior unchanged.

### 2. Add process event and conversation types

Partially started. Conversation identifiers and default conversation constants
exist in the Process runtime. Broader process event, principal, and process
signal types still need to be introduced. Do not change frame transport naming
in this phase.

### 3. Add default process conversations

Completed initial storage slice. The Process DO has a `conversations` table, and
message, queue, pending tool call, and HIL records are scoped to a conversation
and generation. Current behavior is preserved through the `default`
conversation.

### 4. Extend proc syscalls

Completed conversation management slice. `proc.send` and `proc.history` accept
optional `conversationId`, and `proc.conversation.open`, `proc.conversation.list`,
`proc.conversation.get`, and `proc.conversation.close` expose process-local
conversation lifecycle state.

### 5. Add conversation lifecycle operations

Partially completed. `proc.conversation.reset` archives a selected conversation
by default, clears its active messages and queued/runtime state, increments its
generation, and leaves other conversations intact. `proc.conversation.compact`
archives an old prefix of active messages, inserts a visible summary marker at
the prefix boundary, and records a `compaction` segment that can be listed with
`proc.conversation.segments`. Process-wide `proc.reset` and `proc.kill` archive
every non-empty conversation into a directory with one generation file per
conversation before clearing all conversation messages and runtime state.

Still pending: checkpoint and richer segmented history APIs. Preserve raw
transcript archives and visible summary markers.

### 6. Add same-owner IPC

Partially completed. `proc.ipc.send` provides asynchronous same-owner
process-to-process delivery. `proc.ipc.call` adds a bounded call request: the
kernel records a call id and deadline, delivers the request to the target
process, and later sends `ipc.reply` or `ipc.timeout` back to the source
process. Both public syscalls only work from a registered source process,
validate that source and target processes have the same uid, and deliver through
kernel-only `proc.ipc.deliver`.

The process-facing userland shape is the shell `proc` command (`proc send` and
`proc call`) rather than a direct model tool. `proc.ipc.*` remains the syscall
ABI and enforcement point.

Implemented:

- async mail
- bounded call

Still pending:

- delegation helper

Defer cross-user IPC until ACLs are in place.

### 7. Implement Kernel scheduler

Add a clean scheduler store and handlers for the existing `sched.*` syscall
surface. Start with `at`, `every`, `process.spawn`, `process.event`, and
`process.lifecycle`.

### 8. Add filesystem views

Expose process conversations and scheduler state through Linux-like virtual
paths after the underlying state model is stable.

### 9. Add packages and cross-user access

Add package-owned schedules, package event targets, process ACLs, and cross-user
conversation policies once the same-owner model is proven.

## Non-Goals For The First Pass

- renaming `SignalFrame`
- full POSIX compatibility
- arbitrary cross-user IPC
- arbitrary parallel process execution
- advanced cron syntax without a reliable parser
- package-owned timers before process targets work
- replacing `signal.watch` in the same change
