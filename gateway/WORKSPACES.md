# Thread + Workspace Model

This document defines the next major `gateway` shift:

- user-facing unit: **thread**
- durable system object: **workspace**
- execution unit: **process**

A thread is what the user sees and reopens in the UI. A workspace is the durable
filesystem/repo that backs the work. A process is the live runtime attached to a
workspace.

## Terminology

- **Thread**: user-facing name for a unit of ongoing work in the UI.
- **Workspace**: durable, versioned working tree mounted in the filesystem.
- **Process**: live agent loop instance. Processes attach to workspaces.

Threads are UI/runtime concepts. Workspaces are storage concepts. Processes are
execution concepts.

## Core model

- `init:{uid}` remains the user's long-lived orchestrator/root agent.
- A new chat/thread spawns a child process.
- That child process usually gets a new workspace.
- Helper child processes usually inherit the parent's workspace.
- Workspaces outlive processes.
- Reopening a thread attaches a new process to an existing workspace.

This means the durable artifact of work is the workspace, not the process.

## Paths and cwd

Canonical workspace path:

```text
/workspaces/{workspaceId}/
```

We do **not** use `~/workspace`. Home stays home:

- `/root`
- `/home/{user}`

Processes gain a real `cwd`, just like Unix processes. Relative file paths and
shell execution resolve against `cwd`, not always against `home`.

This gives cooperating child processes stable absolute paths when they share the
same workspace.

## Kernel objects

### WorkspaceStore

Kernel SQLite store tracking durable workspaces.

Suggested fields:

- `workspace_id TEXT PRIMARY KEY`
- `owner_uid INTEGER NOT NULL`
- `label TEXT`
- `kind TEXT NOT NULL` (`task` | `app` | `shared`)
- `state TEXT NOT NULL` (`active` | `archived`)
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- `default_branch TEXT NOT NULL`
- `head_commit TEXT`
- `meta_json TEXT`

Future:

- `workspace_members`
- ACLs / sharing
- snapshots / forks

### ProcessRegistry additions

Add:

- `workspace_id TEXT NULL`
- `cwd TEXT NOT NULL`
- `process_type TEXT NOT NULL`
- `profile TEXT NULL`

`init:{uid}` may have no active workspace. Child processes usually do.

### Process types

Process IDs already follow the `<type>:<id>` convention. That should become a
real kernel concept, not just a naming habit.

Initial process types:

- `init:{uid}`: user's persistent root/orchestrator agent
- `task:{id}`: normal user-facing thread worker
- `cron:{jobId}`: scheduled/background process
- `mcp:{id}`: master-control / live-debug / deployment-aware operator process
- `app:{id}`: app/runtime-owned process when we need one

These should not all share the same prompt profile or system awareness.

Examples:

- `task`:
  - user-facing thread work
  - normal coding/file/shell tools
  - workspace-oriented
- `mcp`:
  - kernel/deployment/source aware
  - full SQLite / internal inspection tooling as needed
  - debugging/devops/operator intent, not general chat intent

`proc.spawn` now takes explicit process profile metadata, not only workspace
attachment metadata.

## MCP operator model

`mcp` is not just a stronger chat prompt. It is a trusted operator process with
three distinct forms of awareness:

1. mutable operator instructions
   - profile prompt text lives under `/sys/config/ai/profile/mcp/system_prompt`
   - user overrides can live under `/sys/users/{uid}/ai/profile/mcp/system_prompt`
2. live runtime observability
   - structured syscalls and virtual fs for normal inspection
   - full SQL access for real-time diagnosis and repair when higher-level
     surfaces are insufficient
3. live source + deployment awareness
   - the deployed GSV source is mirrored into ripgit and mounted read-only
   - kernel stores a deployment pointer to the currently deployed commit/ref

In a trusted environment, `mcp` should be able to read and write the real
kernel/process SQLite state. That is the break-glass operator surface, not an
accidental implementation detail.

Suggested operator SQL surface:

- `sql.query`
- `sql.exec`

Suggested targets:

- `kernel`
- `process:{pid}`
- `ripgit:{owner}/{repo}`

Higher-level read surfaces are still valuable for normal debugging, but they do
not replace full SQL access for operator workflows.

## Source mirror

The deployed GSV source should be mirrored into ripgit and mounted inside the
system. This gives `mcp` live access to the code that is actually running.

Recommended mount:

```text
/src/gsv
```

Why `/src/gsv` and not `/lib/gsv`:

- `/src` matches “inspectable source tree”
- `/lib` implies runtime libraries, not the deployed codebase

Policy:

- first deploy seeds the ripgit-backed source repo
- subsequent deploys update the repo
- `/src/gsv` is mounted read-only at the deployed commit/ref
- mutable debugging/repair work still happens in a workspace

This keeps inspection and mutation separate:

- `/src/gsv` = pinned live source mirror
- `/workspaces/{id}` = mutable repair/debug workspace

## Spawn semantics

`proc.spawn` eventually needs explicit workspace attachment rules:

```ts
type ProcWorkspaceSpec =
  | { mode: "none" }
  | { mode: "new"; label?: string; kind?: "task" | "app" | "shared" }
  | { mode: "inherit" }
  | { mode: "attach"; workspaceId: string };
```

Defaults:

- new user-facing thread from init -> `new`
- helper child from a workspace-backed process -> `inherit`

## Workspace backend

Workspace storage is backed by a repo-like service (likely ripgit), but the
kernel talks to it through a semantic API, not through raw git protocol.

Current concrete direction:

- separate `ripgit` Worker/repo
- `gateway` binds to it through the `RIPGIT` Service Binding
- reads and writes go through a narrow internal `/hyperspace/repos/:owner/:repo/*` route over the private gateway-to-ripgit binding
- reads still use repo/file-style fetches; the kernel hides those details behind the workspace backend

The canonical mount is:

```text
/workspaces/{workspaceId}
```

`GsvFs` routes that subtree to a workspace backend. Shell, Files, and `fs.*`
see a normal filesystem.

## Workspace contents

The repo root is the real working tree. A hidden `.gsv/` subtree stores system
metadata.

Minimal v1 layout:

```text
/workspaces/{workspaceId}/
├── .gsv/
│   ├── workspace.json
│   ├── summary.md
│   └── processes/
│       └── {pid}/
│           └── chat.jsonl
└── ...actual task files...
```

Default search/list views should hide `.gsv/` unless explicitly requested.

`.gsv/` is a reserved machine-owned checkpoint area. It should not be treated as
the hot source of truth for active state.

Policy:

- live process state stays in the Process DO
- `.gsv/` stores durable checkpoints, archived transcript slices, and summarized history
- writes to `.gsv/` should happen at compaction/archive boundaries, not every completed turn

Good checkpoint boundaries:

- context compaction / history truncation
- explicit checkpoint
- `proc.kill`
- `proc.reset`
- periodic idle checkpoint when we want a durable archive snapshot

Checkpoint commits should use AI-generated commit messages. That gives us a
second searchable semantic layer over the workspace history and makes later
history/reopen UX much stronger.

## User home vs workspace

Keep the distinction sharp.

Home:

- `~/CONSTITUTION.md`
- `~/context.d/`
- `~/memory/`

Workspace:

- `/workspaces/{workspaceId}/...`

Home is durable personal knowledge. Workspace is durable task/app work.

## Context assembly

Prompt assembly should be a provider pipeline, not one flat storage read path.

The current shape is:

1. base system prompt
2. profile instructions
   - resolved from `/sys/config/ai/profile/{profile}/system_prompt`
   - user overrides can live under `/sys/users/{uid}/ai/profile/{profile}/system_prompt`
3. home knowledge
   - `~/CONSTITUTION.md`
   - `~/context.d/*.md`
4. workspace summary
   - `/workspaces/{id}/.gsv/summary.md`

This keeps the current system simple while moving the boundary to the right
place: providers own where context comes from, and the Process DO only asks for
an assembled prompt.

Provider selection is profile-aware. The kernel stores profile as explicit
process metadata, and the runtime resolves an ordered provider plan for the
prompt purpose from that stored profile.

Near-term provider set:

- `base.system_prompt`
- `profile.instructions`
- `home.knowledge`
- `workspace.summary`

Why `profile.instructions` matters:

- `mcp` should not be hardcoded into developer-only prompt text.
- If the user asks their `mcp` to change how it behaves, it should be able to
  do so by updating supported config state, not by patching the runtime.
- That means provider mechanics stay in code, but profile instructions live in
  mutable system config.

Next providers:

- live process history provider
- workspace retrieval provider
- archived/session retrieval provider
- home memory retrieval provider
- architecture index provider
- runtime snapshot provider
- deployment pointer provider

The important rule is that active state still lives in the Process DO. Providers
do not replace live state; they enrich the prompt with durable or retrieved
context.

The `mcp` profile should eventually use a different provider plan than normal
thread work. At minimum it should include:

- `base.system_prompt`
- `profile.instructions:mcp`
- `system.architecture.index`
- `system.runtime.snapshot`
- `system.deployment.pointer`
- optional `workspace.summary` when attached to a debugging workspace

## First end-to-end flow

1. User clicks "New Thread" in the UI.
2. Kernel asks init to spawn a child process with `workspace: new`.
3. Kernel creates `workspace:{id}` and records `cwd=/workspaces/{id}` for the child process.
4. Chat window binds to that child process.
5. File writes and shell commands from that process resolve relative to the workspace.
6. Files app can open the same workspace.
7. Shell app can open in the same workspace.
8. Closing the thread does not destroy the workspace.
9. Reopening the thread attaches a new process to the same workspace.

That is the v1 "wow" path.

## Non-goals for v1

Keep the first vertical slice strict. Do not expand scope to:

- cross-user shared workspaces
- branch management UI
- public git clone/push UX
- advanced snapshots/forks
- dynamic-worker app backends
- rich `.gsv/` state beyond the minimal files above

## Why this matters

This is the first architecture that makes:

- chat
- files
- shell
- persistence

all refer to the same underlying thing.

That is what should make `gateway` feel like an OS instead of a chat frontend
with tools bolted on.
