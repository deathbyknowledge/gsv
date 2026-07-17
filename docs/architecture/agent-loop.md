# The Agent Loop

The agent loop is the runtime inside a GSV process. It turns incoming messages,
signals, and queued work into model calls, syscall requests, tool results, and
`proc.run.*` / `proc.changed` signals. The loop is not tied to one client. CLI chat, browser apps,
adapter messages, scheduled work, and signal watches all converge on the same
Process DO model.

## Process, Not Session

Each agent process is a Durable Object with a SQLite-backed `ProcessStore`.
Kernel SQLite stores process registry data such as PID, uid/gid, profile, cwd,
workspace id, parent, and state. Process SQLite stores the mutable run state:

- `messages`: active conversation history.
- `pending_tool_calls`: durable tool dispatches from registration through
  terminal result ingestion.
- `message_queue`: FIFO process- and scheduler-origin work received while a run
  is active.
- `pending_hil`: human-in-the-loop tool approval state.
- `process_kv`: process metadata such as identity, profile, current run, and
  process-local context files.

The Kernel delivers frames to the Process DO through `recvFrame`. `proc.send`
starts or supersedes a user run and queues background-origin work, `proc.history` reads stored messages, `proc.reset`
archives and clears history, and `proc.kill` optionally archives history before
wiping the process.

## Message Lifecycle

A normal user message follows this path:

1. The Kernel authorizes the caller and forwards `proc.send` to the target
   Process DO.
2. The process appends the user message immediately. Media preparation proceeds
   in the background and generation waits for it.
3. If no run is active, the process creates `currentRun` and schedules a
   near-immediate `tick`.
4. If a direct user run is active, its outstanding tool calls receive terminal
   interruption results and the new run supersedes it. Process- and
   scheduler-origin work remains FIFO in `message_queue`.
5. The scheduled tick continues the agent loop without keeping one long request
   open.

Ticks are deliberate. Each loop iteration is scheduled through the Durable
Object scheduler so long agent work can cross request/subrequest boundaries
cleanly.

## Prompt Assembly

On the first tick for a run, the process asks the Kernel for runtime inputs:

- `ai.config` resolves provider, model, reasoning, output limit, system/profile context
  files, approval policy, and context byte budget.
- `ai.tools` returns the syscall tool schemas visible to this process and the
  accessible online devices, including owner-authored device descriptions.

The process then assembles a system prompt from explicit context providers in
this order:

1. **System context** from `config/ai/context.d/*.md`.
2. **Profile context** from `config/ai/profile/{profile}/context.d/*.md`, or
   from a package profile when the profile is package-provided.
3. **Home context** from `~/context.d/*.md`, backed by the user's ripgit home
   repository with R2 fallback.
4. **Workspace context** from `/workspaces/{workspaceId}/.gsv/context.d/*.md`,
   or `.gsv/summary.md` when no context files exist.
5. **Available skills** from layered `skills.d` directories. This is a compact
   command-oriented index only; full `SKILL.md` bodies are read explicitly with
   `skills show <skill>`.
6. **Process context** supplied with the assignment or runtime.

Each section is rendered as `[section.name]` and separated with `---`. System
and profile context can template values such as `identity.username`, `identity.cwd`,
`workspace`, `devices`, `mcpServers`, and `known_paths`. Home and workspace context are loaded
lexically and bounded by `config/ai/max_context_bytes`.

Skill discovery reads the owning user's home `skills.d`, the run-as agent's home
`skills.d` when that account is distinct from the owner, and visible enabled
package source repos. Use `pkg source <package>` to locate package-provided skill
files under `/src/repos/<owner>/<repo>`. Profile and workspace directories supply
prompt context, but are not skill discovery roots. The prompt uses a configurable
compact skill index (`summary`, `names`, or `off`) and tells processes to start
unfamiliar work with `man --search -- '<plain-language goal>'`. That live search
returns exact next actions such as `skills show`; long source paths and full skill
bodies are not embedded in standing context.

System-provided skills live in the root GSV source tree under `skills/` and are
seeded into user home `skills.d` during bootstrap when missing.

The assembled prompt, config, tool list, device list, and approval policy are
cached in `currentRun` for the duration of that run.

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

- Text and final-reply media references are emitted through `proc.run.output`;
  streaming blocks flow through `proc.run.stream`.
- Assistant text, thinking blocks, and tool calls are stored in the `messages`
  table.
- If there are no tool calls, the process persists any media registered by
  `message attach` on the final assistant record, emits `proc.run.finished` with
  the same references, and finishes the run.
- If there are tool calls, the process evaluates approval rules and dispatches
  each allowed call as a syscall frame.

Only syscall-backed tools are exposed to the model. Current agent-visible tool
names are `Read`, `Write`, `Edit`, `Delete`, `Search`, `Shell`, and `CodeMode`;
they map to `fs.read`, `fs.write`, `fs.edit`, `fs.delete`, `fs.search`,
`shell.exec`, and `codemode.exec`.

`CodeMode` remains the programmable tool for multi-step orchestration. It can
call `fs.*`, `shell.exec`, and connected MCP tools as generated async
functions.

Routable tools require a `target`. `target: "gsv"` runs the native Kernel
implementation; a device id routes the same syscall to that connected device.

The Process DO does not execute device work itself. It registers the pending
call, sends the request to the Kernel, and waits for a response frame. The Kernel
either handles the syscall natively, forwards it to another Process/AppRunner
surface, or routes it to a device driver.

## Tool Results and Continuation

When a response frame arrives, the process resolves or fails the matching
`pending_tool_calls` row. Once all pending calls for a run are resolved, the
process schedules/continues the loop:

1. Completed syscall results are appended as `toolResult` messages.
2. `proc.changed` tells clients to refresh persisted history.
3. The model is called again with the updated message history.
4. Background-origin queued messages are promoted as separate runs after the
   current run finishes.

This repeats until the model produces a final response without tool calls.

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

Incoming process media is stored outside the message table in R2. Message rows
keep metadata references and the stable `/var/media/{uid}/{pid}/{id}` path.
Before a model call, the Process DO includes that actionable path in attachment
text and hydrates stored raster images into native image content blocks. Audio,
video, vector image, and document media retain the same path alongside transcript
or descriptive fallback text.

The `/var/media` filesystem mount is read-only and checks process ownership
instead of relying on R2 object metadata. Root, the process itself, and sibling
processes owned by the same user can read or stream a file; other users cannot
enumerate or open it. Media is deleted when the process is reset or killed.

## Signals and Background Work

Processes can also wake from watched signals. When a watched signal is delivered,
the process appends a system message describing the signal, watch state, source
PID, and payload. If no run is active, it starts a run. This is how package
daemons, automations, and other system events can feed work into the same agent
loop without pretending to be user chat.

## Checkpointing and Archives

Reset and kill can archive each non-empty conversation under the run-as
identity's home conversation directory before clearing live Process storage.
Live process media is deleted from R2 after referenced bytes have been promoted
to immutable media objects under the run-as agent's home and archive records
have been rewritten to those durable keys. A replacement executor can hydrate
the primary conversation, attachment paths, and bytes from the recorded home
archive without depending on the old executor pid.

## Failure Behavior

The loop treats failures as process events rather than hidden transport details.

- Generation failures are appended as system messages and emitted as
  `proc.run.finished` with `status: "error"`.
- Unknown tool names become synthetic tool-result errors.
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
- [Process Handoffs](./process-handoffs.md)
- [Guides](../how-to/)
