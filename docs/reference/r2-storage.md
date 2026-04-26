# Storage Reference

GSV uses several storage planes. The Kernel chooses the plane based on whether the data is control-plane state, active process state, byte/object data, or versioned repository content.

## Storage Planes

| Plane | Backing Store | Used For |
|---|---|---|
| Kernel SQLite | Kernel Durable Object SQL | Users, groups, tokens, config, devices, routing tables, process registry, workspaces, packages, adapter links, automation, notifications. |
| Process SQLite | Process Durable Object SQL | Active messages, pending tool calls, message queue, HIL state, process-local metadata. |
| AppRunner SQLite/KV | AppRunner Durable Object storage | Package runtime SQL, daemon schedules, loaded package runtime props. |
| R2 `STORAGE` bucket | Cloudflare R2 | Ordinary virtual filesystem files, process media, process archives, package artifacts, CLI download mirrors. |
| ripgit | `RIPGIT` binding | Versioned home knowledge, workspaces, package source repositories, mounted source trees. |

## Virtual Filesystem Mapping

The native `fs.*` and `shell.exec` handlers use `GsvFs`, a Linux-like virtual filesystem with explicit mount routing.

| Path | Backing Store | Notes |
|---|---|---|
| `/sys/*`, `/proc/*`, `/dev/*` | Kernel SQLite and live registries | Virtual control-plane files. |
| `/etc/passwd`, `/etc/shadow`, `/etc/group` | Kernel auth tables | Overlaid on top of regular `/etc` storage. |
| `~/CONSTITUTION.md` | ripgit home repo | User-global identity and standing context. |
| `~/context.d/*` | ripgit home repo, with R2 fallback | User-global prompt context. |
| `~/knowledge/*` | ripgit home repo | Durable knowledge databases. |
| Other home files | R2 | Stored as ordinary objects with uid/gid/mode metadata. |
| `/workspaces/{workspaceId}` | ripgit workspace repo | Mutable, versioned task workspace. |
| `/src/package`, `/src/repo` | ripgit package source mounts | Read-only process mounts. |
| `/usr/local/bin/*` | package mount | Read-only package command shims. |
| Everything else | R2 | Default object-backed filesystem. |

Directory entries in R2 use `.dir` marker objects. File objects store POSIX-like metadata in custom metadata: `uid`, `gid`, `mode`, and optional `dirmarker`.

## Kernel SQLite

Kernel SQLite is the authoritative control-plane store. Important tables include:

| Table | Purpose |
|---|---|
| `passwd`, `shadow`, `groups`, `auth_tokens` | Users, passwords, groups, and issued auth tokens. |
| `config_kv` | Runtime configuration exposed under `/sys/config` and `/sys/users`. |
| `group_capabilities` | Capability grants by group id. |
| `devices`, `device_access` | Registered devices and group access. |
| `routing_table` | In-flight device-routed syscalls. |
| `processes` | Process registry, identity, cwd, workspace, mounts, state. |
| `workspaces` | Workspace metadata. Actual workspace files live in ripgit. |
| `packages` | Installed package manifests, scopes, grants, and artifact hashes. |
| `identity_links`, `surface_routes`, `link_challenges` | Adapter actor links and inbound surface routing. |
| `run_routes` | Routes process chat signals back to clients or adapter surfaces. |
| `automation_kv`, `automation_jobs` | Archivist and curator scheduling state. |
| `notifications`, `signal_watches`, `app_client_sessions` | Notifications, watches, and package UI sessions. |

## Process SQLite

Each Process DO owns its own SQLite database. This keeps active agent-loop state close to the durable process.

| Table | Purpose |
|---|---|
| `messages` | Current conversation history for the process. |
| `pending_tool_calls` | Syscalls waiting on Kernel or device responses. |
| `message_queue` | FIFO queue for messages received while a run is active. |
| `pending_hil` | Human-in-the-loop approval state. |
| `process_kv` | Process metadata such as identity, profile, current run, and archive id. |

On `proc.reset` or `proc.kill`, process messages can be checkpointed into a workspace repo and archived to R2.

## R2 Object Layout

R2 remains the byte store. The current runtime uses these key families:

| Key Pattern | Written By | Purpose |
|---|---|---|
| Any normal filesystem key, for example `home/alice/file.txt` | `R2MountBackend` | Default virtual filesystem storage. |
| `var/media/{uid}/{pid}/{uuid}.{ext}` | Process media handling | Uploaded or adapter-provided media attached to process messages. |
| `var/sessions/{username}/{pid}/{archiveId}.jsonl.gz` | Process reset/kill archive | Gzipped JSONL transcript archive. |
| `runtime/package-artifacts/{hash}.json` | Package install/sync | Package worker artifact loaded by AppRunner. |
| `downloads/cli/{channel}/{asset}` | `sys.bootstrap` CLI mirroring | Downloadable CLI binaries. |
| `downloads/cli/{channel}/{asset}.sha256` | `sys.bootstrap` CLI mirroring | CLI checksums. |
| `downloads/cli/default-channel.txt` | `sys.bootstrap` | Default CLI release channel. |

Process media is deleted by prefix when the process is reset or killed. Package artifacts are content-addressed by hash and referenced from the Kernel `packages` table.

## ripgit Repositories

ripgit stores versioned content. It is used anywhere history, diffs, search, or source snapshots matter.

| Repository | Ref Helper | Mounted At | Purpose |
|---|---|---|---|
| `uid-{uid}/home` | `homeKnowledgeRepoRef(uid)` | `~/CONSTITUTION.md`, `~/context.d`, `~/knowledge` | Home context and knowledge databases. |
| `uid-{uid}/{workspaceId}` | `workspaceRepoRef(workspaceId, uid)` | `/workspaces/{workspaceId}` | Task workspace files and checkpoints. |
| Package source repos, for example `system/gsv` or `{owner}/{repo}` | package manifest `source.repo` | `/src/package`, `/src/repo`, `pkg.repo.*` | Installed package source and review context. |

Workspace repos contain platform metadata under `.gsv/`:

```text
.gsv/workspace.json
.gsv/summary.md
.gsv/context.d/*.md
.gsv/processes/{pid}/chat.jsonl
```

Package source mounts are read-only inside processes. Workspace and home knowledge repos are writable through the filesystem and knowledge syscalls.

## Package Runtime Storage

Installed package records live in Kernel SQLite. The executable artifact is stored in R2 under `runtime/package-artifacts/{hash}.json`. AppRunner loads that artifact into the worker loader and provides package code with package-scoped SQL through `this.storage.sql`.

AppRunner also stores runtime props in Durable Object KV and daemon schedules in its own `app_rpc_schedules` table.

## Practical Rules

- Use Kernel SQLite for authoritative control-plane state.
- Use Process SQLite for active conversation and run state.
- Use R2 for opaque bytes, archives, media, and default filesystem files.
- Use ripgit for user-editable/versioned documents, knowledge, workspace files, and package source.
- Prefer filesystem paths in agent prompts; the mount layer hides the backing store.
