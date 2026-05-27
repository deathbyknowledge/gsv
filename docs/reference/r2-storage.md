# Storage Reference

GSV uses several storage planes. The Kernel chooses the plane based on whether the data is control-plane state, active process state, byte/object data, or versioned repository content.

## Storage Planes

| Plane | Backing Store | Used For |
|---|---|---|
| Kernel SQLite | Kernel Durable Object SQL | Users, groups, tokens, OAuth accounts, config, devices, routing tables, process registry, packages, adapter links, automation, notifications. |
| Process SQLite | Process Durable Object SQL | Active messages, pending tool calls, message queue, HIL state, process-local metadata. |
| AppRunner SQLite/KV | AppRunner Durable Object storage | Package runtime SQL, daemon schedules, loaded package runtime props. |
| R2 `STORAGE` bucket | Cloudflare R2 | Ordinary virtual filesystem files, process media, process archives, package artifacts, CLI download mirrors. |
| ripgit | `RIPGIT` binding | Versioned home knowledge, package source repositories, mounted source trees. |

## Virtual Filesystem Mapping

The native `fs.*` and `shell.exec` handlers use `GsvFs`, a Linux-like virtual filesystem with explicit mount routing.

| Path | Backing Store | Notes |
|---|---|---|
| `/sys/*`, `/proc/*`, `/dev/*` | Kernel SQLite and live registries | Virtual control-plane files. |
| `/etc/passwd`, `/etc/shadow`, `/etc/group` | Kernel auth tables | Overlaid on top of regular `/etc` storage. |
| `~/context.d/*` | ripgit home repo, with R2 fallback | User-global prompt context, including seeded constitution and user files. |
| `~/skills.d/*` | ripgit home repo, with R2 fallback | User-global reusable process skills. |
| `~/knowledge/*` | ripgit home repo | Durable knowledge databases. |
| Other home files | R2 | Stored as ordinary objects with uid/gid/mode metadata. |
| `/src/packages/{packageName}` | ripgit package source plus R2 overlay | Visible installed package source. Writable owned sources stage process-local edits in R2 until explicit commit. |
| `/usr/local/bin/*` | package mount | Read-only package command shims. |
| Everything else | R2 | Default object-backed filesystem. |

Directory entries in R2 use `.dir` marker objects. File objects store POSIX-like metadata in custom metadata: `uid`, `gid`, `mode`, and optional `dirmarker`.

## Kernel SQLite

Kernel SQLite is the authoritative control-plane store. Important tables include:

| Table | Purpose |
|---|---|
| `passwd`, `shadow`, `groups`, `auth_tokens` | Users, passwords, groups, and issued auth tokens. |
| `oauth_accounts`, `oauth_flows` | Stored generic OAuth account credentials and pending authorization-code + PKCE flows. |
| `mcp_servers`, `cf_agents_mcp_servers` | User-owned MCP server metadata plus the Agent MCP client manager's connection/OAuth state. |
| `config_kv` | Runtime configuration exposed under `/sys/config` and `/sys/users`. |
| `group_capabilities` | Capability grants by group id. |
| `devices`, `device_access` | Registered devices and group access. |
| `routing_table` | In-flight device-routed syscalls. |
| `processes` | Process registry, identity, cwd, mounts, state. |
| `packages` | Installed package manifests, scopes, grants, and artifact hashes. |
| `identity_links`, `surface_routes`, `link_challenges` | Adapter actor links and inbound surface routing. |
| `run_routes` | Routes process chat signals back to clients or adapter surfaces. |
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

On `proc.reset` or `proc.kill`, process messages can be archived to R2.

## R2 Object Layout

R2 remains the byte store. The current runtime uses these key families:

| Key Pattern | Written By | Purpose |
|---|---|---|
| Any normal filesystem key, for example `home/alice/file.txt` | `R2MountBackend` | Default virtual filesystem storage. |
| `var/media/{uid}/{pid}/{uuid}.{ext}` | Process media handling | Uploaded or adapter-provided media attached to process messages. |
| `var/sessions/{username}/{pid}/{archiveId}.jsonl.gz` | Process reset/kill archive | Gzipped JSONL transcript archive. |
| `runtime/package-artifacts/{hash}.json` | Package install/sync | Package worker artifact loaded by AppRunner. |
| `public/gsv/downloads/cli/{channel}/{asset}` | `sys.bootstrap` CLI mirroring | Downloadable CLI binaries served through `/public/*`. |
| `public/gsv/downloads/cli/{channel}/{asset}.sha256` | `sys.bootstrap` CLI mirroring | CLI checksums served through `/public/*`. |
| `public/gsv/downloads/cli/default-channel.txt` | `sys.bootstrap` | Default CLI release channel. |
| `public/gsv/downloads/cli/install.{sh,ps1}` | `sys.bootstrap` | Static CLI install scripts served through `/public/*`. |
| `public/gsv/assets/tts/**` | `sys.bootstrap` Piper asset seeding | Browser-local TTS runtime, WASM, and default voice assets served through `/public/*`. |
| `process-source-overlays/{pid}/{packageId}/manifest.json` | Package source mount, `pkg source` | Manifest of staged package source edits for one process/package. |
| `process-source-overlays/{pid}/{packageId}/files/{path}` | Package source mount, `pkg source` | Staged file content for package source puts. |

Process media is deleted by prefix when the process is reset or killed. Package artifacts are content-addressed by hash and referenced from the Kernel `packages` table.

## ripgit Repositories

ripgit stores versioned content. It is used anywhere history, diffs, search, or source snapshots matter.

| Repository | Ref Helper | Mounted At | Purpose |
|---|---|---|---|
| `{username}/home` | `homeKnowledgeRepoRef(username)` | `~/context.d`, `~/skills.d`, `~/knowledge` | Home context, skills, and knowledge databases. |
| Package source repos, for example `root/gsv` or `{owner}/{repo}` | package manifest `source.repo` | `/src/packages/{packageName}`, `repo.*` | Installed package source, review context, and generic repo operations. |

The `root/gsv` repository may contain a top-level `skills/` directory. Bootstrap
copies those files into user home repos under `skills.d/` when they are missing.

Package source mounts are always visible for installed packages the process identity can see. Sources owned by the current user are writable through a process-local R2 overlay; `pkg source status`, `pkg source diff`, `pkg source commit`, and `pkg source discard` make commit/discard explicit. Other package sources are read-only. Home knowledge repos are writable through the filesystem; generic repository operations use `repo.*`, and Wiki-specific behavior uses the higher-level knowledge interface.

## Package Runtime Storage

Installed package records live in Kernel SQLite. The executable artifact is stored in R2 under `runtime/package-artifacts/{hash}.json`. AppRunner loads that artifact into the worker loader and provides package code with package-scoped SQL through `this.storage.sql`.

AppRunner also stores runtime props in Durable Object KV and daemon schedules in its own `app_rpc_schedules` table.

## Practical Rules

- Use Kernel SQLite for authoritative control-plane state.
- Use Process SQLite for active conversation and run state.
- Use R2 for opaque bytes, archives, media, and default filesystem files.
- Use ripgit for user-editable/versioned documents, knowledge, and package source.
- Prefer filesystem paths in agent prompts; the mount layer hides the backing store.
