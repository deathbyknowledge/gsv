# The Agent Loop

The agent loop is the runtime inside a GSV process. It turns incoming messages,
signals, and queued work into model calls, syscall requests, tool results, and
`chat.*` signals. The loop is not tied to one client. CLI chat, browser apps,
adapter messages, scheduled work, and signal watches all converge on the same
Process DO model.

## Process, Not Session

Each agent process is a Durable Object with a SQLite-backed `ProcessStore`.
Kernel SQLite stores process registry data such as PID, uid/gid, profile, cwd,
workspace id, parent, and state. Process SQLite stores the mutable run state:

- `messages`: active conversation history.
- `pending_tool_calls`: syscalls waiting for Kernel or device responses.
- `message_queue`: FIFO messages received while a run is active.
- `pending_hil`: human-in-the-loop tool approval state.
- `process_kv`: process metadata such as identity, profile, current run, and
  process-local context files.

The Kernel delivers frames to the Process DO through `recvFrame`. `proc.send`
starts or queues a run, `proc.history` reads stored messages, `proc.reset`
archives and clears history, and `proc.kill` checkpoints and clears process
state.

## Message Lifecycle

A normal user message follows this path:

1. The Kernel authorizes the caller and forwards `proc.send` to the target
   Process DO.
2. The process stores attached media in R2 under `var/media/{uid}/{pid}/`.
3. If no run is active, the process appends a user message, creates `currentRun`,
   and schedules a near-immediate `tick`.
4. If a run is already active, the message is persisted in `message_queue` and
   the caller receives `queued: true`.
5. The scheduled tick continues the agent loop without keeping one long request
   open.

Ticks are deliberate. Each loop iteration is scheduled through the Durable
Object scheduler so long agent work can cross request/subrequest boundaries
cleanly.

## Prompt Assembly

On the first tick for a run, the process asks the Kernel for runtime inputs:

- `ai.config` resolves provider, model, reasoning, output limit, profile context
  files, approval policy, and context byte budget.
- `ai.tools` returns the syscall tool schemas visible to this process and the
  accessible online devices.

The process then assembles a system prompt from explicit context providers in
this order:

1. **Profile context** from `config/ai/profile/{profile}/context.d/*.md`, or
   from a package profile when the profile is package-provided.
2. **Home context** from `~/context.d/*.md`, backed by the user's ripgit home
   repository with R2 fallback.
3. **Workspace context** from `/workspaces/{workspaceId}/.gsv/context.d/*.md`,
   or `.gsv/summary.md` when no context files exist.
4. **Process context** supplied with the assignment or runtime.

Each section is rendered as `[section.name]` and separated with `---`. Profile
context can template values such as `identity.username`, `identity.cwd`,
`workspace`, `devices`, and `known_paths`. Home and workspace context are loaded
lexically and bounded by `config/ai/max_context_bytes`.

The assembled prompt, config, tool list, device list, and approval policy are
cached in `currentRun` for the duration of that run.

## Model and Tool Cycle

Each tick builds a `pi-ai` context from the system prompt, stored messages, and
available tools. The process calls the configured generation service with
`sessionAffinityKey` set to the PID.

The model response can contain text, thinking blocks, and tool calls:

- Text is emitted immediately as `chat.text`.
- Assistant text, thinking blocks, and tool calls are stored in the `messages`
  table.
- If there are no tool calls, the process emits `chat.complete` and finishes the
  run.
- If there are tool calls, the process evaluates approval rules and dispatches
  each allowed call as a syscall frame.

Only syscall-backed tools are exposed to the model. Current agent-visible tool
names are `Read`, `Write`, `Edit`, `Delete`, `Search`, and `Shell`; they map to
`fs.read`, `fs.write`, `fs.edit`, `fs.delete`, `fs.search`, and `shell.exec`.
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
2. `chat.tool_result` is emitted for clients.
3. Any queued user messages are injected at the tool-result boundary.
4. The model is called again with the updated message history.

This repeats until the model produces a final response without tool calls.

Tool result content is stored as text. Non-string syscall output is JSON encoded
for the model history, while the live `chat.tool_result` signal also carries the
raw output or error for clients.

## Human-in-the-Loop Approval

Tool approval is profile-configured with JSON at
`config/ai/profile/{profile}/tools/approval`. If no policy is configured, GSV
defaults to:

- Auto-allow most tools.
- Ask before `shell.exec`.
- Ask before `fs.delete`.

Rules can match exact syscalls or wildcard domains and can inspect facts such as
profile, target type, tags, paths, commands, and argument prefixes. The approval
engine tags risky operations, including destructive commands, hidden paths,
paths outside cwd/home, remote device targets, privileged commands, and network
commands.

Approval outcomes are:

- `auto`: emit `chat.tool_call` and dispatch the syscall.
- `deny`: append a synthetic tool error.
- `ask`: store `pending_hil` and emit `chat.hil`.

The run pauses while a HIL request is pending. A user or adapter reply resumes it
through `proc.hil` with `approve` or `deny`. Non-interactive profiles such as
`cron`, `archivist`, and `curator` cannot ask; an `ask` decision becomes a tool
error.

## Queueing and Abort

A process handles one run at a time. New messages received during an active run
are persisted in `message_queue`.

If the active run has tool calls, queued messages are drained after tool results
arrive and before the next model call, so the model can account for follow-up
messages in the same run. If the active run completes without that boundary, the
next queued message is promoted into a new run.

`proc.abort` stops the current run. Pending tool calls are converted to
interruption errors when possible, pending HIL state is cleared, `chat.complete`
is emitted with `aborted: true`, and the next queued message is promoted unless
continuation must wait for a tool-result phase to finish safely.

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

Process conversation state is active runtime state, not the durable artifact of
work. When a process is reset or killed, GSV can:

- Generate/update `/workspaces/{workspaceId}/.gsv/summary.md`.
- Write a process transcript to
  `/workspaces/{workspaceId}/.gsv/processes/{pid}/chat.jsonl`.
- Commit those files to the workspace ripgit repository.
- Archive the old message history to
  `var/sessions/{username}/{pid}/{archiveId}.jsonl.gz` in R2.
- Delete process media from R2.

Workspaces therefore outlive processes. A process can be reset, killed, or
replaced while the durable workspace and its summary continue carrying task
state forward.

## Failure Behavior

The loop treats failures as process events rather than hidden transport details.

- Generation failures are appended as system messages and emitted as
  `chat.complete` with an error.
- Unknown tool names become synthetic tool-result errors.
- Denied or unapproved tools become tool-result errors visible to the model.
- Kernel/device routing errors are stored as failed pending tool calls and fed
  back into the next model call.
- Stale scheduled ticks are ignored when their run id no longer matches
  `currentRun`.

This keeps the model's history aligned with what actually happened. If a syscall
failed, the next model call sees that failure as a tool result and can choose a
different approach.
