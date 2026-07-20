# Storage Reference

GSV uses several storage planes. The owning runtime chooses the plane based on
whether data is global control-plane state, per-user control-plane state, active
process state, byte/object data, or versioned repository content. The R2 bucket
and virtual filesystem remain shared across user Kernels.

## Storage Planes

| Plane | Backing Store | Used For |
|---|---|---|
| Master Kernel SQLite | `singleton` Kernel Durable Object SQL | Permanent canonical account-name and uid/gid reservations, password/token verifiers, groups, capabilities, provisioning, package/configuration authority, adapter links and persistent link generations, and existing global control state. Public admission and the expanded audit/budget model remain target work. |
| User Kernel SQLite | `user:<canonical-username>` Kernel Durable Object SQL | Provisioning binding, sessions, devices, routing tables, process registry, projected packages/configuration, OAuth/MCP state, automation, and notifications for one active human. |
| Process SQLite | Process Durable Object SQL | Active messages, pending tool calls, message queue, HIL state, process-local metadata. |
| AppRunner control SQLite | `app-control-v3:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` Durable Object | Exact-bound app runtime/session control state and daemon schedules for one Kernel-owner, run-as actor, and package tuple. |
| Package data SQLite | `app-data-v2:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` Durable Object | Package-reachable SQL for exactly one Kernel-owner uid, actor uid, and package tuple. |
| R2 `STORAGE` bucket | Cloudflare R2 | Ordinary virtual filesystem files, process media, process archives, and package artifacts. |
| ripgit | `RIPGIT` binding | Versioned home knowledge, workspaces, package source repositories, and source trees. |

## Virtual Filesystem Mapping

The native `fs.*` and `shell.exec` handlers use `GsvFs`, a Linux-like virtual filesystem with explicit mount routing.

| Path | Backing Store | Notes |
|---|---|---|
| `/sys/*`, `/proc/*`, `/dev/*` | Master/user Kernel SQLite and live registries | Authorized global and per-user control-plane views. |
| `/etc/passwd`, `/etc/shadow`, `/etc/group` | Current Kernel auth tables | Master is authoritative; user Kernels receive filtered, credential-free projections. These projected files are read-only. |
| `~/context.d/*` | ripgit home repo, with R2 fallback | User-global prompt context, including seeded constitution and user files. |
| `~/skills.d/*` | ripgit home repo, with R2 fallback | User-global reusable process skills. |
| `~/knowledge/*` | ripgit home repo | Durable knowledge databases. |
| Other home files | R2 | Stored as ordinary objects with uid/gid/mode metadata. |
| `/src/repos/{owner}/{repo}` | ripgit repo plus R2 overlay | Visible source repositories. Writable repos stage process-local edits in R2 until explicit `rgit commit`. |
| `/workspaces/{workspaceId}` | ripgit workspace repo | Mutable, versioned task workspace. |
| `/usr/local/bin/*` | package mount | Read-only package command shims. |
| Everything else | R2 | Default object-backed filesystem, excluding the internal namespaces below. |

Directory entries in R2 use `.dir` marker objects. File objects store POSIX-like metadata in custom metadata: `uid`, `gid`, `mode`, and optional `dirmarker`. Explicit directory markers govern traversal and child creation. Conditional R2 writes bind replacements to the ETag that was authorized and bind new objects to non-existence.

R2 does not interpret those fields. Every user-reachable operation goes through
GsvFs or a narrow typed store that derives uid/gids from authenticated Kernel
authority and applies owner/group/other permissions. A `home/<username>` prefix
is convenient addressing, not a physical security namespace; per-user buckets
or prefixes are not required for isolation.

Legacy markerless prefixes remain implicit directories, and legacy objects
without ACL metadata retain the compatibility default. They must be inventoried,
classified, and migrated before the fail-closed multiuser storage gate in the
[Multiuser Security Architecture](../architecture/multiuser-security.md) can be
enabled.

## Kernel SQLite

The Master Control Program and each active user Kernel own the datasets listed
below. Package/configuration records are a documented transitional exception:
the Master is their sole writer and user Kernels store replaceable projections.
Legacy accounts keep their user-owned tables in `singleton` until an explicit
state migration exists.

Migration v21 gives every Kernel DO one durable `kernel_projection_state` row.
On the Master it holds the committed and pending monotonic projection revision
plus a package fence. On a user Kernel it records the installed canonical
username, uid, Kernel generation, exact Master revision, SHA-256 snapshot digest,
and package fence. An older revision or a different digest under the same
revision is rejected. A persisted package fence keeps admission closed across
eviction until recovery re-prepares runtimes, installs the exact committed
snapshot, and clears the fence from leaves inward.

Migration v22 adds `app_runtime_runners` and
`app_runtime_lifecycle_fences`. The registry contains only AppRunner control or
data objects observed after a successful current Kernel authorization. Each row
stores the exact runner name, package actor username/uid, controlling
human Kernel-owner username/uid, package id, and observation times. The Kernel
owner, run-as actor, and package jointly determine the runner name; the Kernel
owner determines fence authority.
Lifecycle rows bind an owner, exact source Kernel, generation, UUID fence id,
destination lifecycle, and creation time. These tables enumerate package drains
and durably reassert lifecycle barriers; a deterministic DO name is not itself
authority.

| Owner | Tables/data | Purpose |
|---|---|---|
| Master | `passwd`, `shadow`, `groups`, `auth_tokens`, permanent account reservations | Canonical usernames, never-reused uid/gid values, password/token verification, group membership, account lifecycle, and user-Kernel provisioning generation. |
| Master | `group_capabilities`, package records, authoritative `config_kv`, adapter-account/link directory, `identity_link_generations`, and existing global control state | Ship-wide/cross-user authorization plus package, configuration, and adapter-link authority. Link/unlink advances a generation that remains recorded after removal; bounded route projections are not implemented. Admission policy and expanded audit/budget state remain target work. |
| User Kernel | `oauth_accounts`, v23 owner-bound `oauth_flows`, MCP records; projected `config_kv` | One human's OAuth/MCP state and a filtered runtime configuration view. Pre-v23 authorization-code callback rows remain unbound and fail closed. |
| User Kernel | `devices`, `device_access`, `routing_table`, `shell_sessions` | Owned device catalog, access projection, in-flight routes, and transport state. |
| User Kernel | `processes`, `conversations`, `run_routes`, `ipc_calls` | Process registry and user-facing routing; Process DOs still own execution history. |
| User Kernel | projected package records, schedules, notifications, watches, app-session indexes, surface routes | One human's package runtime view, automation, and local delivery control plane. Adapter identity links remain Master-only. |
| Master and user Kernel | `kernel_projection_state`, `app_runtime_runners`, `app_runtime_lifecycle_fences` | Monotonic projection revision/digest, crash-durable package fences, exact actually-used AppRunner identity registry, and fail-closed user-lifecycle fence intent. |

## Process SQLite

Each Process DO owns its own SQLite database. This keeps active agent-loop state close to the durable process.

| Table | Purpose |
|---|---|
| `messages` | Current conversation history for the process. |
| `pending_tool_calls` | Durable tool dispatch ledger from registration through terminal result ingestion. |
| `message_queue` | FIFO process- and scheduler-origin work received while a run is active. |
| `pending_hil` | Human-in-the-loop approval state. |
| `process_kv` | Process metadata such as identity, profile, current run, and archive id. |

`proc.reset`, `proc.kill`, and conversation compaction archive exact process
messages to owner-scoped internal R2 storage.

A user-Kernel lifecycle fence is an abort, not reset or kill. It cancels active
generation-`N` work but preserves Process SQLite, queued input, history, and
media. Authorized activation may rebind only same-owner registry records from
the exact immediate predecessor generation; failed activation re-fences those
executors instead of deleting their storage.

## R2 Object Layout

R2 remains the shared byte store. The runtime uses these key families:

| Key Pattern | Written By | Purpose |
|---|---|---|
| Any normal filesystem key, for example `home/alice/file.txt` | `R2MountBackend` | Default virtual filesystem storage. The immutable username stabilizes the path; uid/gid/mode metadata authorizes it. |
| `var/media/{ownerUid}/{pid}/{uuid}.{ext}` | Process media handling | Uploaded or adapter-provided media attached to process messages. Internal; scoped to the human process owner and accessed through `proc.media.*`, not generic `fs.*`. |
| `process-conversation-archives/{ownerUid}/{agentUid}/{conversationId}/*.jsonl.gz` | Process reset, kill, and compaction | Private gzipped JSONL transcripts, addressed independently of executor pid and authorized to the human owner. |
| `runtime/package-artifacts/{hash}.json` | Package install/sync | Versioned package worker artifact loaded by AppRunner. Unversioned records without `publicFiles` are read-only legacy compatibility records pending verified conditional migration. |
| `runtime/app-placement/verification-key-v1.json` | Master Control Program | Root-owned, mode-`0444`, internal P-256 public SPKI record used by the Gateway to verify app placement before selecting a user DO. The private key never enters R2. |
| `public/gsv/packages/{hash}/...` | Package install/sync | Create-only, root-owned browser assets confined to a cryptographically verified artifact namespace. |
| `process-source-overlays/{pid}/{sourceKey}/manifest.json` | `/src/repos`, `rgit` | Manifest of staged source edits for one process/repo. |
| `process-source-overlays/{pid}/{sourceKey}/files/{path}` | `/src/repos`, `rgit` | Staged file content for source puts. |

Process media is stamped with the owner's uid/gid, mode `000`, and an internal
storage-class marker. Reads and deletes validate both its exact owner/pid prefix
and that metadata. It is deleted by owner/pid prefix when the process is reset
or killed, but not when a user-Kernel lifecycle fence aborts an active run.
Package artifacts are content-addressed by hash and referenced from the owning
package control-plane record.

The Master keeps the matching app-placement private key only in `singleton` DO
storage. If that private record is missing while the public R2 trust anchor
still exists, it refuses to generate a silent replacement. Edge verification
fails closed until an explicit ship recovery reconciles the key pair.

The generic non-root filesystem does not mount `var/media`,
`process-conversation-archives`, `runtime/package-artifacts`, or
`process-source-overlays`, or the app-placement verification key. Legacy
`home/{agent}/conversations` paths are also
reserved so old shared-agent archives cannot be read through `fs.*`. `/public` is readable
but only root may mutate it. Recursive R2 deletion first
authorizes every object in the prefix so a writable or markerless parent cannot
erase another identity's objects. Each deletion then claims the exact authorized
ETag with a non-writable tombstone before issuing R2's unconditional delete, so
a concurrent replacement is not erased. R2 `.dir` marker objects are never
addressable through the public filesystem API.

## ripgit Repositories

ripgit stores versioned content. It is used anywhere history, diffs, search, or source snapshots matter.

Repository owner segments use immutable canonical usernames. Retirement does
not release the segment, and authorization still checks the stored owner uid and
visibility policy rather than trusting a path string.

For Git HTTP, `singleton` performs only the bounded credential, lifecycle,
generation, capability, and repository-ACL admission check. Once admitted, the
Gateway gives the original request to RIPGIT, which owns request bodies,
packfiles, repository mutations, and response streams. Neither the Master nor a
user Kernel relays that data plane.

| Repository | Ref Helper | Mounted At | Purpose |
|---|---|---|---|
| `{username}/home` | `accountHomeRepoRef(username)` | `~/context.d`, `~/skills.d`, `~/knowledge` | Home context, account-local skills, and knowledge databases. |
| Wiki repos, for example `root/gsv-manual` or `{owner}/{wiki}` | repo manifest `wiki.json` | Wiki app, `/src/repos/{owner}/{wiki}`, `repo.*` | Durable markdown knowledge databases. |
| Package source repos, for example `root/gsv` or `{owner}/{repo}` | package manifest `source.repo` | `/src/repos/{owner}/{repo}`, `repo.*`, `rgit` | Installed package source, review context, and generic repo operations. |
| `{username}/{workspaceId}` | `workspaceRepoRef(workspaceId, username)` | `/workspaces/{workspaceId}` | Task workspace files and checkpoints. |

The `root/gsv` repository may contain a top-level `skills/` directory. Bootstrap
copies those files into user home repos under `skills.d/` when they are missing.

Workspace repos contain normal versioned task files. Process transcript
archives live in owner-scoped internal storage rather than workspace metadata.

Generic visible repos are available under `/src/repos/{owner}/{repo}`. Repos writable by the process identity accept `fs.write`, `fs.edit`, and `fs.delete`, but those writes stage into a process-local R2 overlay. Use `rgit status`, `rgit diff`, `rgit commit`, and `rgit discard` to inspect, commit, or discard staged repo edits. Read-only visible repos still support read and search. `pkg source <package>` reports the package's source repo path; package lifecycle stays under `pkg`, while repository history and source edits stay under `rgit`. Wiki-specific behavior uses the higher-level Wiki app and CLI on top of the same repo storage.

## Package Runtime Storage

Package records currently live in the Master Control Program and are copied into
active user Kernels as filtered runtime projections. The executable artifact is
stored once in shared R2 under `runtime/package-artifacts/{hash}.json`.
AppRunner loads that artifact into the worker loader. Authority-bearing HTTP,
socket, command, signal, and schedule state lives only in the structurally
attested
`app-control-v3:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` database.
Approved package code sees package-scoped SQL through `this.storage.sql`, but
those statements are forwarded to the distinct data-only
`app-data-v2:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` object. Package SQL
can therefore neither read nor modify `app_rpc_schedules` or the control
migration ledger.

Before a package-authority mutation, the v21 package fence closes and drains
package-stamped Kernel operations, exact-generation package Processes,
schedules, and the v22 registry's observed control/data AppRunners. AppRunner
fences close admission and sockets, abort tracked cancelable request/response
and outbound streams, delete alarms, durably increment a never-reused runtime
epoch, and wait for each tracked SQL, command, signal, and daemon wrapper to
release. Loader RPC promises without a cancellation handle are abandoned when
their wrapper is aborted and remain observed; the revoked epoch carried by the
Loader key, entrypoint, and package-to-platform binding prevents their late work
from acquiring current authority. The committed projection revision and digest
install before AppRunner and Kernel fences clear; interrupted package
transitions remain unavailable and recover from durable fence state.

The hard cut leaves pre-owner-qualified `app-control-v2:` and `app-data:`
objects, plus the older combined `app:<uid>:<package-id>` objects, untouched and
unreachable. A new
`app-data-v2:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` database is fresh;
legacy package rows have not been migrated. Existing package SQL continuity is
a release gate until an explicit migration inventories and verifies data
without trusting the old, package-writable control schema or migration ledger.

## Practical Rules

- Use Master Kernel SQLite for global identity and authorization state.
- Use user Kernel SQLite for one human's control-plane state.
- Use Process SQLite for active conversation and run state.
- Use R2 for opaque bytes, archives, media, and default filesystem files.
- Use ripgit for user-editable/versioned documents, knowledge, workspace files, and package source.
- Prefer filesystem paths in agent prompts; the mount layer hides the backing store.

## See also

- [Configuration](./configuration.md)
- [Context Files](./context-files.md)
- [Architecture Overview](../architecture/)
