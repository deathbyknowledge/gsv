# Process Spawn, Delegation, and Handoff Model

## Goal

Define how long-lived `init` processes, focused `task` processes, and other profile-scoped processes should spawn, communicate, delegate work, and hand off user-facing conversations.

This note is intentionally separate from prompt/context and knowledge-system design. It defines process coordination semantics.

## Core principles

1. `init` is the default point of contact.
2. `task` is the focused worker profile for bounded execution.
3. Inter-process control flow should not be modeled only as chat messages.
4. Durable process history and provider-facing conversation arrays are different things.
5. Routing ownership changes must be explicit.

## Profiles

### `init`

- Main user-facing process.
- Long-lived.
- Owns the user relationship.
- Handles simple asks directly.
- Delegates bounded or tool-heavy work when focus or isolation is useful.

### `task`

- Focused worker process.
- Usually workspace-scoped.
- Created to complete a bounded objective.
- Produces artifacts, summaries, or an explicit handoff.

### Other profiles

- `app`, `cron`, `review`, and `mcp` remain specialized.
- They may also spawn or message other processes, but they are not the default user front door.

## Three distinct operations

### 1. Delegation

Parent process asks another process to perform a bounded job and waits for the result.

Use when:

- `init` wants a focused worker to do a subtask.
- The parent process remains the active conversational owner.

Semantics:

- The child process gets an assignment.
- The child runs independently.
- The parent waits for a summarized result.
- The parent resumes and continues the user-facing conversation.

This is logically synchronous at the model layer, even if implemented with asynchronous runtime plumbing underneath.

### 2. Handoff

Ownership of the active conversation or surface moves from one process to another.

Use when:

- A focused task should become the ongoing process for that thread.
- The user is no longer primarily talking to `init`.

Semantics:

- Routing for that surface/thread is updated to the new process.
- The old process becomes supervisor, coordinator, or idle.
- The user should see an explicit handoff event.

This is not just a tool result. It is routing state plus a visible transition.

### 3. Message

Asynchronous process-to-process communication.

Use when:

- A background process finishes later.
- A child wants to notify a parent.
- Two processes need loose coordination.

Semantics:

- Message delivery is durable.
- Delivery does not automatically appear in the active model turn.
- A process may consume it later, surface it to the user, or ignore it according to policy.

## Recommended syscall surface

### `proc.spawn`

- Creates a new process.
- Default behavior is asynchronous.
- Returns at least `pid`.

Use for:

- Fire-and-forget process creation.
- Low-level runtime control.

### `proc.delegate`

- Convenience operation over spawn + assignment + wait.
- Returns a bounded result to the caller.

Use for:

- `init -> task` focused subtask execution.
- Synchronous collaboration at the model layer.

### `proc.handoff`

- Transfers routing ownership of the current surface or conversation to another process.

Use for:

- Moving a user thread from `init` into a long-running `task`.

### `proc.message`

- Sends an asynchronous durable message between processes.

Use for:

- Completion notifications.
- Background coordination.

## Durable history model

Process history should use typed events, not only chat messages.

Recommended event kinds:

- `user_message`
- `assistant_message`
- `tool_call`
- `tool_result`
- `process_spawn`
- `process_delegate_result`
- `process_handoff`
- `process_mail`

This is the durable event log.

## Provider-facing model message array

The model message array should be derived from history, not equal to history.

Rules:

- Normal user and assistant messages project into the provider conversation.
- Tool calls and tool results project into the provider conversation.
- Delegation may project as a tool call/result pair.
- Handoff should usually not project as a fake conversation turn.
- Async mail should not be injected retroactively as a fake tool result.

This keeps provider history valid and avoids inventing misleading chat turns.

## Child bootstrap

Child processes should receive assignment context as process state, not as a fake user message.

Recommended shape:

- Store a bounded `assignment` object in child process state.
- Expose it during prompt assembly as a dedicated context section.

Why:

- It is honest.
- It avoids polluting user-visible transcript history.
- It makes delegation and spawned work easier to reason about.

## Default interaction model

### `init` handles directly

Use when:

- The request is simple.
- No focused worker is needed.

### `init` delegates to `task`

Use when:

- The request is bounded and execution-heavy.
- The result can be summarized back into the parent conversation.

### `init` hands off to `task`

Use when:

- The thread is becoming an ongoing focused workstream.
- The new process should own subsequent inbound messages.

## Routing implications

Routing ownership is separate from transcript content.

Required behavior:

- A handoff changes which process receives future inbound messages.
- Delegation does not change inbound routing by default.
- Async messages do not implicitly change routing.

## Why this split is preferred

This model keeps:

- conversation history structurally valid for providers,
- routing semantics explicit,
- child process assignments honest,
- synchronous delegation easy for models to reason about,
- asynchronous work cleanly separated from chat history.

## Recommended implementation order

1. Add typed process history events.
2. Add `proc.delegate`.
3. Add child assignment context.
4. Add `proc.handoff`.
5. Add `proc.message`.

This gives a clean `init -> task` story first, without forcing all process coordination through fake chat-message semantics.
