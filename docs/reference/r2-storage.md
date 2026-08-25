# Storage Reference

GSV uses several storage planes. The owning runtime chooses the plane based on
whether data is ship-wide authority, one human's runtime coordination, active
Process state, opaque bytes, package state, or versioned repository content.
The R2 bucket and virtual filesystem remain shared across user Kernels.

## Storage planes

| Plane | Backing store | Used for |
| --- | --- | --- |
| Master Kernel SQLite | `singleton` Kernel Durable Object SQL | Permanent canonical account-name and uid/gid reservations, credential verifiers, groups, capabilities, commissioning/placement, package and configuration authority, normalized repository metadata, adapter accounts and identity links, login/link throttles, and global control state |
| User Kernel SQLite | `user:<canonical-username>` Kernel Durable Object SQL | Matching username/uid marker, connections and sessions, devices, process registry, routes, schedules, app sessions, OAuth/MCP state, automation, and notifications for one active human |
| Process SQLite | Process Durable Object SQL | Active messages, pending tool calls, message queue, HIL state, and process-local metadata |
| AppRunner SQLite | `app:<actorUid>:<packageId>` Durable Object SQL | Package-reachable SQLite and daemon schedules for one ship-global run-as uid and package; the object also owns its live runtime and sockets |
| R2 `STORAGE` bucket | Cloudflare R2 | Ordinary virtual-filesystem bytes, process media, conversation archives, package artifacts, and source overlays |
| ripgit | `RIPGIT` binding | Versioned home knowledge, workspaces, package source, wiki repositories, and general repositories |

User Kernels do not store account, capability, configuration, package,
repository, or adapter-link authority. They resolve that state through typed
live Master RPCs and master-owned syscalls. A table being present in the shared
Kernel schema does not authorize a user Kernel to populate or consult it as a
second source of truth.

## Virtual filesystem mapping

The native `fs.*` and `shell.exec` handlers use GsvFs, a Linux-like virtual
filesystem with explicit mount routing.

| Path | Backing store | Notes |
| --- | --- | --- |
| `/proc/*`, `/dev/*` | Owning user Kernel SQLite and live registries | Authorized process and device runtime views |
| `/sys/config/*`, `/sys/capabilities/*` | Typed Master reads | Authorized views of the single configuration and capability authority |
| `/etc/passwd`, `/etc/shadow`, `/etc/group` | Typed Master auth-file reads | Field- and caller-filtered; `/etc/shadow` remains root-only |
| `~/context.d/*` | ripgit home repo, with R2 fallback | User-global prompt context, including seeded constitution and user files |
| `~/skills.d/*` | ripgit home repo, with R2 fallback | User-global reusable process skills |
| `~/knowledge/*` | ripgit home repo | Durable knowledge databases |
| Other home files | R2 | Ordinary objects with uid/gid/mode metadata |
| `/src/repos/{owner}/{repo}` | ripgit repo plus R2 overlay | Visible source repositories; writable edits stage until explicit `rgit commit` |
| `/workspaces/{workspaceId}` | ripgit workspace repo | Mutable, versioned task workspace |
| `/usr/local/bin/*` | Package mount | Read-only package command shims |
| Everything else | R2 | Default object-backed filesystem, excluding internal key families below |

R2 directory entries use `.dir` marker objects. File objects store POSIX-like
metadata in custom metadata: `uid`, `gid`, `mode`, and optional `dirmarker`.
Explicit directory markers govern traversal and child creation. Conditional R2
writes bind replacement to the ETag that was authorized and new-object creation
to non-existence.

R2 does not interpret those fields. Every user-reachable operation goes through
GsvFs or a narrow typed store that derives uid/gids from authenticated Kernel
identity and applies owner/group/other permissions. A `home/<username>` prefix
is convenient addressing, not a physical security namespace; per-user buckets
or prefixes are not required for isolation.

The user-Kernel cutoff does not move, copy, rename, or rewrite existing R2
objects. Their existing uid/gid/mode metadata remains authoritative. Missing,
malformed, or ambiguous ownership fails closed and requires an explicit root
repair; v16 does not guess ownership.

## Kernel SQLite ownership

The Master and user Kernels run the same Kernel class, but they own different
datasets.

| Owner | Tables/data | Purpose |
| --- | --- | --- |
| Master | `passwd`, `shadow`, `groups`, `auth_tokens`, `personal_agents`, `account_identities`, `unix_id_allocator`, `user_kernels` | Canonical usernames, never-reused uid/gid values, credentials, account relationships, and commissioning/placement |
| Master | `group_capabilities`, `config_kv`, `packages`, repository metadata, adapter account/link directory, `identity_link_generations` | Ship-wide authorization, configuration, packages, repository admission metadata, and external-actor identity. Link/unlink advances a revision retained after removal |
| Master | `auth_login_attempts`, `link_challenge_attempts`, token-revocation outbox/tombstones | Durable abuse control and credential revocation work |
| User Kernel | `oauth_accounts`, owner-bound `oauth_flows`, MCP records | One human's OAuth/MCP credentials, flows, servers, and callback state |
| User Kernel | `devices`, `device_access`, `routing_table`, `shell_sessions` | Owned device catalog, device ACL, in-flight routes, and transport state |
| User Kernel | `processes`, `conversations`, `run_routes`, `ipc_calls` | Process registry and user-facing routing; Process DOs still own execution history |
| User Kernel | `schedules`, notifications, watches, app-session records, surface routes | One human's automation, local app sessions, and delivery control plane |

Master-owned public reads include `account.get`, `sys.cap.list`,
`sys.config.get`, `pkg.list`, and `repo.list`. Internal runtime callsites use
equally narrow typed reads. The Master reconstructs the caller and applies
field-level visibility; a user Kernel does not copy the result into durable
authority tables.

Durable Object SQLite changes use the numbered migrations in
`gateway/src/kernel/schema/` and `gateway/src/app-runner/schema/`. Store
constructors must not create or alter schema opportunistically.

## Process SQLite

Each Process DO owns its own SQLite database. This keeps active agent-loop state
close to the durable process.

| Table | Purpose |
| --- | --- |
| `messages` | Current conversation history for the Process |
| `pending_tool_calls` | Durable tool dispatch ledger from registration through terminal result ingestion |
| `message_queue` | FIFO Process- and scheduler-origin work received while a run is active |
| `pending_hil` | Human-in-the-loop approval state |
| `process_kv` | Process metadata such as identity, profile, current run, and archive id |

`proc.abort` stops active work without deleting the Process. `proc.reset`,
`proc.kill`, and conversation compaction archive exact messages to owner-scoped
internal R2 storage according to their lifecycle contract. Late output from
cancelled or superseded work cannot mutate the active run.

## R2 object layout

R2 remains the shared byte store. The runtime uses these key families:

| Key pattern | Written by | Purpose |
| --- | --- | --- |
| Any normal filesystem key, for example `home/alice/file.txt` | `R2MountBackend` | Default virtual-filesystem storage. The immutable username stabilizes the path; uid/gid/mode metadata authorizes it |
| `var/media/{ownerUid}/{pid}/{uuid}.{ext}` | Process media handling | Uploaded or adapter-provided media attached to Process messages. Internal and accessed through `proc.media.*`, not generic `fs.*` |
| `process-conversation-archives/{ownerUid}/{agentUid}/{conversationId}/*.jsonl.gz` | Process reset, kill, and compaction | Private gzipped JSONL transcripts, addressed independently of executor pid and authorized to the human owner |
| `runtime/package-artifacts/{hash}.json` | Package install/sync | Versioned package worker artifact loaded by AppRunner. Unversioned records without `publicFiles` are read-only compatibility inputs pending verified conditional migration |
| `public/gsv/packages/{hash}/...` | Package install/sync | Create-only, root-owned browser assets confined to a cryptographically verified artifact namespace |
| `process-source-overlays/{pid}/{sourceKey}/manifest.json` | `/src/repos`, `rgit` | Manifest of staged source edits for one Process/repository |
| `process-source-overlays/{pid}/{sourceKey}/files/{path}` | `/src/repos`, `rgit` | Staged source file content |

Process media is stamped with the owner's uid/gid, mode `000`, and an internal
storage-class marker. Reads and deletes validate both its exact owner/pid prefix
and metadata. It is deleted by owner/pid prefix according to Process reset/kill
semantics. Package artifacts are content-addressed by hash and referenced from
the Master-owned package record.

The generic non-root filesystem does not mount `var/media`,
`process-conversation-archives`, `runtime/package-artifacts`, or
`process-source-overlays`. Pre-owner conversation pointers are invalidated by
the security migration; an ordinary user-created `~/conversations` directory
otherwise follows the same uid/gid/mode checks as any other home path. `/public`
is readable but only root may mutate it. Package assets may have markerless
intermediate prefixes beneath `/public`; GsvFs treats those prefixes as
synthetic root-owned read-only directories while continuing to validate every
leaf object's filesystem metadata. The shell's synthetic `/usr/bin` lookup path
is likewise read-only and does not confer R2 mutation authority. Other nested
R2 directories require an explicit valid `.dir` marker.

`/home` is not enumerated from raw R2 prefixes. GsvFs builds it from the account
directory and returns only runnable accounts plus registered homes whose
explicit marker grants the current uid/gids read and execute access. Child
operations continue through account-home routing and Unix permission checks.

Recursive R2 deletion first authorizes every object in the prefix. Each
deletion then claims the exact authorized ETag with a non-writable tombstone
before issuing R2's unconditional delete, so a concurrent replacement is not
erased. R2 `.dir` marker objects are never addressable through the public
filesystem API.

## ripgit repositories

ripgit stores versioned content anywhere history, diffs, search, or source
snapshots matter. Repository owner segments use immutable canonical usernames.
Deleting an account does not release the segment, and authorization still
checks the stored owner uid and visibility policy rather than trusting the path.

For Git HTTP, the Master performs only bounded credential, active-placement,
capability, repository-owner, and ACL admission. Once admitted, the Gateway
gives the original request to RIPGIT, which owns request bodies, packfiles,
repository mutations, and response streams. Neither the Master nor a user
Kernel relays that data plane.

| Repository | Ref helper | Mounted at | Purpose |
| --- | --- | --- | --- |
| `{username}/home` | `accountHomeRepoRef(username)` | `~/context.d`, `~/skills.d`, `~/knowledge` | Home context, account-local skills, and knowledge databases |
| Wiki repos, for example `root/gsv-manual` or `{owner}/{wiki}` | Repo manifest `wiki.json` | Wiki app, `/src/repos/{owner}/{wiki}`, `repo.*` | Durable Markdown knowledge databases |
| Package source repos, for example `root/gsv` or `{owner}/{repo}` | Package manifest `source.repo` | `/src/repos/{owner}/{repo}`, `repo.*`, `rgit` | Installed package source, review context, and generic repo operations |
| `{username}/{workspaceId}` | `workspaceRepoRef(workspaceId, username)` | `/workspaces/{workspaceId}` | Task workspace files and checkpoints |

The `root/gsv` repository may contain a top-level `skills/` directory. Bootstrap
copies missing files into user home repos under `skills.d/`.

Writable repositories mounted under `/src/repos/{owner}/{repo}` accept
`fs.write`, `fs.edit`, and `fs.delete`, but those writes stage in a
Process-local R2 overlay. Use `rgit status`, `rgit diff`, `rgit commit`, and
`rgit discard` to inspect, commit, or discard them. Read-only visible repos
still support read and search.

## Package runtime storage

Package records live only in the Master. The executable artifact is stored once
in shared R2 under `runtime/package-artifacts/{hash}.json`. Before an AppRunner
loads it, the active user Kernel validates the current run-as account,
enabled/reviewed package, artifact hash, entrypoint, and requested operation
through the Master.

The deterministic `app:<actorUid>:<packageId>` AppRunner owns
package-reachable SQL, daemon schedules, live sockets, and runtime state for one
ship-global actor uid and package. The object name is not authority; access is
possible only through current user-Kernel authorization. App-session records
and HMAC keys remain in the owning user Kernel. A pre-split props record without
`kernelName` is rebound in place on its first authorized request or daemon
alarm; its object name and SQLite do not move.

## Practical rules

- Use Master Kernel SQLite for global identity and authorization state.
- Use user Kernel SQLite for one human's runtime control-plane state, never a
  copy of Master authority.
- Use Process SQLite for active conversation and run state.
- Use AppRunner SQLite for one actor/package's package state and daemon
  schedules.
- Use R2 for opaque bytes, archives, media, and default filesystem files.
- Use ripgit for user-editable/versioned documents, knowledge, workspace files,
  and package source.
- Prefer filesystem paths in agent prompts; the mount layer hides the backing
  store.

## See also

- [Configuration](./configuration.md)
- [Context Files](./context-files.md)
- [Architecture Overview](../architecture/)
