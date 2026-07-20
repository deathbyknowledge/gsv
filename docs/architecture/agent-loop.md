# The Agent Loop

The agent loop is the runtime inside a GSV process. It turns incoming messages,
signals, and queued work into model calls, syscall requests, tool results, and
`proc.run.*` / `proc.changed` signals. The loop is not tied to one client. CLI chat, browser apps,
adapter messages, scheduled work, and signal watches all converge on the same
Process DO model.

## Process, Not Session

Each agent process is a Durable Object with a SQLite-backed `ProcessStore`.
The owning user Kernel SQLite stores process registry data such as PID,
canonical owner username, uid/gid, profile, cwd, workspace id, parent, and state.
Process SQLite stores the mutable run state:

- `messages`: active conversation history.
- `pending_tool_calls`: durable tool dispatches from registration through
  terminal result ingestion.
- `message_queue`: FIFO process- and scheduler-origin work received while a run
  is active.
- `pending_hil`: human-in-the-loop tool approval state.
- `process_kv`: process metadata such as identity, profile, current run, and
  process-local context files.

The owning user Kernel delivers frames to the Process DO through `recvFrame`. `proc.send`
starts or supersedes a user run and queues background-origin work, `proc.history` reads stored messages, `proc.reset`
archives and clears history, and `proc.kill` optionally archives history before
wiping the process.

## Message Lifecycle

A normal user message follows this path:

1. The owning user Kernel authorizes the caller and forwards `proc.send` to the target
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

On the first tick for a run, the process asks its owning user Kernel for runtime inputs:

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

Skill sources follow the same layered shape: profile `skills.d`, `~/skills.d`,
workspace `.gsv/skills.d`, and visible package source repos. Use
`pkg source <package>` to locate package-provided skill files under
`/src/repos/<owner>/<repo>`. The prompt tells processes to use `skills list`,
`skills search`, `skills show`, `skills files`, and `skills read` rather than
embedding long source paths in the index.

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

- Text is emitted through `proc.run.output` and streaming blocks through
  `proc.run.stream`.
- Assistant text, thinking blocks, and tool calls are stored in the `messages`
  table.
- If there are no tool calls, the process emits `proc.run.finished` and finishes the
  run.
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
call, sends the request to its installed owning user-Kernel route, and waits for
a response frame. That Kernel either handles the syscall natively, forwards it
to another Process/AppRunner surface, or routes it to a device driver. A global
or cross-user operation may make a narrow Master Control Program call; ordinary
syscalls do not traverse `singleton`.

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

The run pauses while a HIL request is pending. A user or adapter reply resumes it
through `proc.hil` with `approve` or `deny`. Non-interactive profiles such as
`cron` cannot ask; an `ask` decision becomes a tool error.

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
keep metadata references. Before a model call, the Process DO hydrates stored
image media back into image content blocks. Audio, video, and document media are
represented with transcript or descriptive fallback text.

Media is scoped to the process under `var/media/{uid}/{pid}/` and is deleted
when the process is reset or killed.

## Signals and Background Work

Processes can also wake from watched signals. When a watched signal is delivered,
the process appends a system message describing the signal, watch state, source
PID, and payload. If no run is active, it starts a run. This is how package
daemons, automations, and other system events can feed work into the same agent
loop without pretending to be user chat.

## Checkpointing and Archives

Reset and kill can archive each non-empty conversation under the run-as
identity's home conversation directory before clearing live Process storage.
Process media is deleted from R2. A replacement executor can hydrate the primary
conversation from the recorded home archive.

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
