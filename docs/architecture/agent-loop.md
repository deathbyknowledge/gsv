# The Agent Loop

The agent loop is the runtime inside a GSV process. It turns incoming messages,
signals, and queued work into model calls, syscall requests, tool results, explicit
`message send` and `yield` choices, and `proc.run.*` / `proc.changed` signals. The loop is
not tied to one client. CLI chat, browser apps, adapter messages, scheduled work,
and signal watches all converge on the same Process DO model.

Process history is raw execution activity, not the canonical user conversation.
See [Conversations and Process Activity](./conversations.md) for Ship, Work,
message synchronization, endpoint delivery, and retention.

## Process, Not Session

Each agent process is a Durable Object with a SQLite-backed `ProcessStore`.
Kernel SQLite stores process registry data such as PID, uid/gid, cwd,
parent, and state. Process SQLite stores the mutable run state:

- `messages`: process history.
- `pending_tool_calls`: durable tool dispatches from registration through
  terminal result ingestion.
- `message_queue`: FIFO process- and scheduler-origin work received while a run
  is active.
- `pending_hil`: human-in-the-loop tool approval state.
- `process_kv`: process metadata.

The Kernel delivers frames to the Process DO through `recvFrame`. Direct clients
append canonical input with `conversation.send`, which privately admits the same
interaction to its handler Process. Adapter ingress follows the same Kernel-owned
conversation path. `proc.send` remains the Process admission primitive and handles
background-origin work, `proc.history` reads raw Process activity, `proc.reset`
archives and clears that activity, and `proc.kill` optionally archives it before
wiping the Process. None of those lifecycle operations deletes canonical messages.

## Message Lifecycle

A normal user message follows this path:

1. The Kernel authorizes the direct client or adapter, appends the canonical user
   message, and selects the conversation's handler Process.
2. Before Process admission, the Kernel installs the run's directed client or
   adapter endpoint. It then forwards the interaction through `proc.send` or
   `proc.adapter.deliver` with the conversation and input-message identities.
3. The Process appends its raw user-input activity immediately. Media preparation proceeds
   in the background and generation waits for it.
4. If no run is active, the Process creates `currentRun` and schedules a
   near-immediate `tick`.
5. If a direct user run is active, its outstanding tool calls receive terminal
   interruption results and the new run supersedes it. Process- and
   scheduler-origin work remains FIFO in `message_queue`.
6. The scheduled tick continues the agent loop without keeping one long request
   open.

An unnamed spawned task publishes a bounded fallback title immediately and
uses `ai.text.generate` in background to replace it with a concise title derived
from the first admitted message. Explicit process labels opt out. Title
generation is independent of the task run: failure retains the fallback and
never delays message admission or model execution. The generated result remains
scoped to the source history generation, so a reset or process teardown
cancels its provider request and invalidates any late output.

Ticks are deliberate. Each loop iteration is scheduled through the Durable
Object scheduler so long agent work can cross request/subrequest boundaries
cleanly.

## Prompt Assembly

On the first tick for a run, the process asks the Kernel for runtime inputs:

- `ai.config` resolves provider, model, reasoning, output limit, system context
  files, approval policy, and context byte budget.
- `ai.tools` returns the syscall tool schemas visible to this process and the
  accessible online devices, including owner-authored device descriptions.

The process then assembles a system prompt from explicit context providers in
this order:

1. **System context** from `config/ai/context.d/*.md`.
2. **Home context** from `~/context.d/*.md`, backed by the user's ripgit home
   repository with R2 fallback.
3. **Available skills** from layered `skills.d` directories. This is a compact
   command-oriented index only; full `SKILL.md` bodies are read explicitly with
   `skills show <skill>`.

Skill discovery reads the owning user's home `skills.d` and the run-as agent's
home `skills.d` when that account is distinct from the owner.
The prompt uses a configurable compact skill index (`summary`, `names`, or
`off`) and tells processes to start unfamiliar work with
`man --search -- '<plain-language goal>'`. That live search returns exact next
actions such as `skills show`; long source paths and full skill bodies are not
embedded in standing context.

System-provided skills are bundled into the gateway and seeded into user home
`skills.d` during bootstrap. Before prompt skill discovery, the gateway restores
any missing built-in paths while preserving existing files.

The assembled prompt, config, tool list, device list, and approval policy are
cached in `currentRun` for the duration of that run.

Managed `mail.received` runtime events are a restricted notification path. The
Kernel sends only the stable message id, receipt time, a summary of at most 280
bytes, classification, attention flag, and optional confidence. The Process
rejects extra fields, canonicalizes the summary to one line, and renders the
quoted email-derived summary as untrusted data rather than instructions. A mail
notification run is persisted as notify-only, including while queued, and that
mode is recovered after Durable Object eviction. Notify-only generations
receive no tools, devices, or MCP bindings. The next human message starts an
ordinary run with the normal runtime surface restored. A notify-only run may
take one recovery turn after a
fabricated tool response; a second such response terminates the run so an
untrusted email cannot create an unbounded inference loop.

Endpoint routing does not alter that standing system prompt. The first
model-visible message that owns a run, and the next such message whenever its
delivery semantics change, receives a concise chronological annotation such as
`[Directed endpoint: this Telegram direct message.]`. It appears
beside the existing `[From: ...]` annotation without changing the stored
message. A route-less run names the GSV process history instead. A
non-distinct runtime event that joins an active run is
only annotated with its source; it does not change that run's directed endpoint.
This keeps prior provider input byte-stable when a later message arrives from
another client or adapter, preserving prefix-cache reuse.

## Model and Tool Cycle

Each tick builds a `pi-ai` context from the system prompt, stored messages, and
available tools. MCP tools are not expanded into the direct model tool surface;
processes use them intentionally through CodeMode's generated async functions
or the native shell `mcp` command, both of which dispatch back through
`sys.mcp.*`. CodeMode keeps a fixed tool description and exposes ready MCP
function names and schemas through the runtime `mcpTools` array. Processes first
return a compact index, inspect the selected schema on demand, and then call its
generated function. Generated functions unwrap MCP result envelopes inside
CodeMode, while the underlying syscall path still preserves the raw MCP response
for shell and low-level callers.

The process calls the configured generation service with `sessionAffinityKey`
set to the PID.

The model response can contain text, thinking blocks, and tool calls:

- Text, reasoning, and tool-call blocks are raw Process activity. They are emitted
  through `proc.run.output` / `proc.run.stream` only to the run owner and clients
  that explicitly called `proc.observe`.
- Assistant text, thinking blocks, and tool calls are stored in the `messages`
  table.
- In a human-facing run, a direct Shell call with a literal `message send <<'GSV_MESSAGE'` block
  commits one canonical user-visible message and any media registered by `message attach`. The run
  continues, allowing multiple exactly-once messages from one run.
- A direct `yield` finishes the run. Composing the final send as `message send ... && yield` avoids
  another generation; a bare `yield` finishes without another Message.
- Once the Process validates a message command, the originating client receives
  `message.started` and `message.delta`. Adapters wait for `message.committed`.
- Ordinary assistant text in a human-facing run that stops without yielding causes one `[GSV EVENT]`
  correction. A second omission ends the run with an inspectable bounded error.
- A rejected message or run-control command gets five correction attempts. Delivery failures use a
  separate three-attempt budget and tell the model to retry the exact same message command.
- If there are tool calls, the process evaluates approval rules and dispatches
  each allowed call as a syscall frame.

The exact tool names included in each generation request are persisted with the
run. A returned tool call may be registered or executed only when that exact
name was offered for that generation. Calls fabricated by a provider, including
`Shell` or `CodeMode`, are never registered, approved, or dispatched. They are
still preserved in assistant history with synthetic terminal tool results so
provider history remains structurally valid and the next model turn can recover
instead of silently completing or hanging.

Only the fixed syscall-backed tool surface is exposed to the model. Current agent-visible
tool names are `Read`, `Write`, `Edit`, `Delete`, `Search`, `Shell`, and `CodeMode`;
they map to `fs.read`, `fs.write`, `fs.edit`, `fs.delete`, `fs.search`,
`shell.exec`, and `codemode.exec`.

The message and run-control commands are Process-owned Shell intrinsics. They do not add model tools,
require `shell.exec` approval, target a device, or enlarge the composable tool surface. An explicit
`message send --to ... --also` remains an ordinary approved shell operation for additional or
cross-channel delivery.

`CodeMode` remains the programmable tool for multi-step orchestration. It can
call `fs.*`, `shell.exec`, and connected MCP tools as generated async
functions.

Routable tools require a `target`. `target: "gsv"` runs the native Kernel
implementation; a device id routes the same syscall to that connected device.

The Process DO does not execute device work itself. It registers the pending
call, sends the request to the Kernel, and waits for a response frame. The Kernel
either handles the syscall natively, forwards it to another Process, or routes
it to a device driver.

## Tool Results and Continuation

When a response frame arrives, the process resolves or fails the matching
`pending_tool_calls` row. Each execution that emitted `proc.run.tool.started`
also emits a best-effort `proc.run.tool.finished` when that durable dispatch
first reaches a terminal outcome. Both signals share the unique dispatch
`executionId`; the terminal signal contains only process/run identity, provider
call identity, outcome, and timestamp—not arguments, output, or error content.
Clients deduplicate by `executionId` and recover missed terminal events from
persisted history. Once all pending calls for a run are resolved, the process
schedules/continues the loop:

1. Completed syscall results are appended as `toolResult` messages.
2. `proc.changed` tells clients to refresh persisted history.
3. The model is called again with the updated message history.
4. Background-origin queued messages are promoted as separate runs after the
   current run finishes.

This repeats until a human-facing run uses `yield`. `message send` alone commits a Message and
continues the loop. A bounded IPC call omits the human-delivery instruction and finishes when the worker
returns ordinary assistant output; that output becomes its caller result.

Tool result content is stored as text. Non-string syscall output is JSON encoded
for model history.

## Human-in-the-Loop Approval

Tool approval is profile-configured with JSON at
`config/ai/profile/{profile}/tools/approval`. If no policy is configured, GSV
defaults to:

- Auto-allow most tools.
- Ask before `shell.exec`.
- Ask before `fs.delete`.
- Ask before `sys.mcp.call`.

Rules can match exact syscalls or wildcard domains and can inspect facts such as
profile, target type, tags, paths, commands, and argument prefixes. The approval
engine tags risky operations, including destructive commands, hidden paths,
paths outside cwd/home, remote device targets, privileged commands, and network
commands.

Approval outcomes are:

- `auto`: emit `proc.run.tool.started` and dispatch the syscall.
- `deny`: append a synthetic tool error.
- `ask`: store `pending_hil` and emit `proc.run.hil.requested`.

The run pauses while a HIL request is pending. A native client resumes it through
`proc.hil` with the exact pending `requestId`. An adapter DM prompt renders that
identity as `hil[requestId]`; its approval or denial must include the exact
current token, for example `approve hil[...]` or `deny hil[...]`. A bare decision
or stale token does not call `proc.hil` and receives a reminder for the current
request. The provider `replyToId` remains threading metadata, not authorization.
Non-interactive profiles such as `cron` cannot ask; an `ask` decision becomes a
tool error.

The Kernel broadcasts an admitted HIL request to native clients before handling
its adapter notification. Adapter notification retries are Kernel-owned durable
scheduled work with a stable delivery id; notification failure never rolls back
or clears `pending_hil`.

## Queueing and Abort

A process handles one run at a time. A new direct user message supersedes the
active run. Every outstanding provider tool call receives a terminal error
result before the new user message is appended, so provider history remains
valid. Process- and scheduler-origin messages do not preempt; they remain FIFO in
`message_queue` and are promoted as distinct runs.

`proc.abort` applies the same logical cancellation to the current run without
starting a replacement user turn. Pending HIL state is cleared,
`proc.run.finished` is emitted with `status: "aborted"`, and the next queued run
is promoted. An optional expected `runId` makes stale abort requests harmless.
Late tool responses are ignored after their durable dispatch row is cleared.

## Media Handling

Incoming media and image-bearing tool results are stored outside the message
table in R2. New message boundaries carry revision-bound resource blocks; the
Process retains external sources once in the run-as agent's immutable archive.
Before a model call, it includes the actionable path in attachment text and
hydrates stored raster images into native image content blocks. Audio, video,
vector image, and document media retain the same reference alongside transcript
or descriptive fallback text.

For the supported upgrade path, legacy tool-result rows that contain a typed
image inside JSON text are reconstructed as image blocks with the encoded bytes
removed from their text block. New results always use resource references.

The `/var/media` filesystem mount is read-only and checks process ownership
instead of relying on R2 object metadata. Root, the process itself, and sibling
processes owned by the same user can read or stream a file; other users cannot
enumerate or open it. Media is deleted when the process is reset or killed.

## Signals and Background Work

Processes can also wake from watched signals. When a watched signal is delivered,
the process appends a system message describing the signal, watch state, source
PID, and payload. If no run is active, it starts a run. This is how automations
and other system events can feed work into the same agent
loop without pretending to be user chat.

## Checkpointing and Archives

Reset and kill can archive non-empty process history under the run-as identity's
home process directory before clearing live Process storage.
Live process media is deleted from R2 after referenced bytes have been promoted
to immutable media objects under the run-as agent's home and archive records
have been rewritten to those durable keys. `proc.fork` can initialize a new
process from committed history without sharing live run, queue, tool, or HIL
state with the source process.

## Failure Behavior

The loop treats failures as process events rather than hidden transport details.

- Generation failures are appended as system messages and emitted as
  `proc.run.finished` with `status: "error"`.
- Unknown or unoffered tool names become synthetic tool-result errors without
  being registered or executed.
- Denied or unapproved tools become tool-result errors visible to the model.
- Kernel/device routing errors are stored as failed pending tool calls and fed
  back into the next model call.
- Stale scheduled ticks are ignored when their run id no longer matches
  `currentRun`.

This keeps the model's history aligned with what actually happened. If a syscall
failed, the next model call sees that failure as a tool result and can choose a
different approach.

## See also

- [Process IPC and Scheduler](./process-ipc-and-scheduler.md)
- [Context Compaction & Memory](./context-compaction.md)
- [Guides](../how-to/)
