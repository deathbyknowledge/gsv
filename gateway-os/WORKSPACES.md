# Thread + Workspace Model

This document defines the next major `gateway-os` shift:

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

`init:{uid}` may have no active workspace. Child processes usually do.

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
- `gateway-os` binds to it through the `RIPGIT` Service Binding
- writes go through a narrow internal `/_gsv/apply` route guarded by `RIPGIT_INTERNAL_KEY`
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

## User home vs workspace

Keep the distinction sharp.

Home:

- `~/CONSTITUTION.md`
- `~/context.d/`
- `~/memory/`

Workspace:

- `/workspaces/{workspaceId}/...`

Home is durable personal knowledge. Workspace is durable task/app work.

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

That is what should make `gateway-os` feel like an OS instead of a chat frontend
with tools bolted on.
