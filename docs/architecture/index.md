# Architecture Overview

GSV is a personal cloud computer: an always-on operating system for humans,
machines, and agents. It runs on Cloudflare, but it is intentionally modeled like
a Linux-like computer rather than a chatbot backend. Users have identities,
agents are processes, storage is exposed as a filesystem, capabilities are
reached through syscalls, and external machines appear as devices.

This is a mental model, not POSIX compatibility. The point is to give humans and
AI processes familiar operating-system affordances: inspectable files, stable
paths, process IDs, permissions, device targets, packages, and command surfaces.

## When to read this

Read this section when you want the system model rather than task-by-task
instructions. If you are new to GSV and just want a running deployment, start
with [Get Started](../get-started/). If you are trying to solve one specific
operational task, [How-to Guides](../how-to/) will usually get you there faster.

## Suggested reading path

A good order is:

1. this overview
2. [The Agent Loop](./agent-loop.md)
3. [Process IPC and Scheduler](./process-ipc-and-scheduler.md)
4. [The Adapter Model](./adapter-model.md)
5. [Context and Knowledge](./context-and-knowledge.md)
6. [Security Model](./security-model.md)
7. [Multiuser Security Architecture](./multiuser-security.md)

## Architecture pillars

### Kernel

The Gateway Worker and Kernel Durable Objects are the GSV kernel. The Worker
owns HTTP/WebSocket entrypoints. Kernel DOs provide serialized control-plane
coordination behind them.

One deployed Gateway and its bound storage stack is exactly one ship. Its Kernel
named `singleton` is the Master Control Program. Freshly commissioned and newly
created login-capable humans have a Kernel named
`user:<canonical-username>`; accounts discovered during the v16 upgrade remain
explicitly `legacy` until their state can be migrated safely. Independent
ships use independent deployments; serving several ships from one deployment
is not supported until every DO name, R2 key, AppRunner, and service route is
explicitly ship-scoped.

The Master Control Program is responsible for:

- Permanently reserving canonical account names and allocating never-reused
  uids/gids.
- Verifying passwords and tokens and owning ship-wide login abuse budgets.
- Maintaining groups, capabilities, account lifecycle, cross-user grants, and
  user-Kernel provisioning generations. Public admission policy remains a
  target design and is not exposed yet.
- Owning package records and configuration mutations during the current
  transition; user Kernels receive filtered runtime projections. The v21 state
  machine binds each installation to an exact Master revision and SHA-256
  digest and fences package mutations until active targets have drained and
  installed the committed revision.

A ship-wide security-audit ledger for root and global mutations is a
multiuser release gate. No such ledger or audit-query surface is implemented
yet.

Each user Kernel is responsible for:

- The human's browser, CLI, device, and scoped service connections.
- Sessions, devices, process/conversation registry, routes, notifications, and
  schedules.
- OAuth/MCP state and the projected package/configuration view needed by local
  runtime handlers.
- Dispatching syscalls such as `fs.read`, `shell.exec`, `proc.spawn`,
  `pkg.sync`, `sys.config.get`, `sys.oauth.start`, `sys.mcp.add`, and
  `adapter.inbound`.
- Routing requests between browser clients, the CLI, package apps, Process DOs,
  adapter workers, and connected devices.

Kernel migration v23 binds every newly created generic OAuth flow to the human
Kernel owner that admitted it. Authorization-code callbacks acquire that exact
owner's lifecycle admission before consuming state and retain it through the
bounded exchange and commit. Pre-v23 callback states remain unbound and fail
closed.

The Kernel remains the syscall and policy boundary, but steady-state runtime
coordination is physically sharded by human. Process DOs run agents, AppRunner
DOs run package code, and devices execute local hardware work. The owning user
Kernel decides whether a normal caller is allowed to do something and where the
request should go. Global identity operations, package/configuration operations,
and adapter link resolution currently use narrow typed calls to `singleton`.
Active app and adapter payloads do not use those calls as a data path: app
placement is P-256-certified and verified at the edge before user-DO selection,
while adapter payloads bypass the bounded Master link/placement lookup.

### Agent Processes

Agents are durable processes, not sessions. Each user has a long-lived init
process, `init:{uid}`, and can spawn child processes with `proc.spawn`. A process
has a PID, uid/gid identity, parent, profile, current working directory, optional
workspace, state, and persistent message history.

Process state lives in a Process Durable Object with its own SQLite database.
That database stores active messages, pending tool calls, queued messages,
human-in-the-loop state, and process-local metadata. The owning user Kernel
registry stores the process metadata needed for routing and permissions.

The agent loop belongs to the Process DO. It assembles context, calls the model,
receives tool calls, issues syscalls, waits for results, and emits `proc.run.*`
and `proc.changed` signals through its owning user Kernel. `gsv chat` is
therefore just one client for a process; browser apps and adapters can target
the same process model.

### Filesystem and Storage

GSV exposes a virtual filesystem through `GsvFs`. Agents and apps interact with
paths such as `/home/alice`, `/workspaces/{workspaceId}`, `/sys`, `/proc`,
`/var`, `/dev`, `/etc`, `/src/repos`, and `/usr/local/bin` instead of storage
APIs.

Different path families are backed by different stores:

- Master and user Kernel SQLite back their respective control-plane paths such
  as `/sys`, `/proc`, `/dev`, and auth/config overlays in `/etc`.
- Process SQLite backs active conversation and run state.
- R2 stores ordinary bytes, process media, archives, and package artifacts.
- ripgit stores versioned home knowledge, workspace trees, package source, and
  repository content.

This split matters operationally, but it should be hidden from agents whenever
possible. The filesystem is the stable interface. Prompt context follows the
same rule: profile context, `~/context.d/*.md`, workspace `.gsv/context.d/*.md`,
and current process context are ordinary inspectable files or explicit runtime
providers.

### Devices

Devices are connected machines that implement part of the syscall surface. A
device driver connects over WebSocket with a hardware descriptor containing its
device id, platform, version, owner, and `implements` list such as:

```json
{ "deviceId": "macbook", "implements": ["fs.*", "shell.exec", "net.fetch"] }
```

Agents always see the same tool names: `Read`, `Write`, `Edit`, `Delete`,
`Search`, `Shell`, and `CodeMode`. The `target` argument selects where the
syscall runs.
`target: "gsv"` uses the native cloud implementation inside the Worker sandbox.
`target: "macbook"` routes the same `fs.*`, `shell.exec`, or `net.fetch`
syscall to that device after ownership, group ACL, online-state, and capability
checks.

This is the hardware abstraction layer. Devices can be laptops, servers, or any
CLI-run machine, but agents do not need a different API for each one. A device
connects through `/ws/<owner-username>` and remains coordinated by that owner's
user Kernel.

### Packages and Apps

Packages are GSV software. A package declares a manifest, source repository,
entrypoints, and requested capabilities. Entry points can be browser UI, backend
HTTP/RPC, CLI commands, or package profiles.

Package source is resolved from ripgit, assembled by the assembler worker, stored
as an immutable artifact in R2, and executed by AppRunner Durable Objects.
AppRunner gives package code a scoped runtime with:

- Kernel access through the package SDK.
- Package-scoped SQLite in a data-only DO, separate from runtime control state.
- Browser boot metadata and backend RPC sessions.
- Optional public routes for webhooks.
- CLI command handlers that behave like OS commands.

The result is closer to an OS app model than a plugin folder. Packages can call
Kernel syscalls with granted capabilities, expose UI in the web shell, store
their own state, ship commands, and be reviewed or installed from repository
source.

### Git and Distribution

ripgit is GSV's built-in Git service and repository API. It supports Git HTTP
paths for clone/fetch/push and an internal `/hyperspace/repos/...` API used by
the Kernel for reads, writes, search, package analysis, snapshots, and upstream
imports.

GSV uses repositories for more than source control:

- `{username}/home` stores user-global knowledge and context.
- `{username}/{workspaceId}` stores workspace files and checkpoints.
- `root/gsv` stores the bootstrapped GSV source at the configured release ref.
- Package source repositories provide installable apps and CLI commands.

This is how GSV keeps its own source inspectable, installs packages from repos,
and exposes public package metadata to other GSVs. Distribution is
repository-based rather than registry-only: a package is source plus manifest
plus assembled artifact. Canonical usernames are immutable and never reused,
so username-addressed repositories remain stable; access still follows uid/gid
and explicit repository policy.

## How Requests Move

A typical chat request follows this path:

```text
CLI, browser, or adapter
  -> Gateway Worker
  -> owning user Kernel (`user:<username>`)
  -> Process DO
  -> model call
  -> syscall request
  -> owning user Kernel dispatch
  -> native handler, Process DO, AppRunner, or device driver
  -> response
  -> Process DO continues the run
  -> proc.run.* signals return through user-Kernel run routing
  -> original client or adapter surface
```

The same dispatcher handles non-chat requests. A package app can issue
`fs.read`; the user Kernel checks the package entrypoint grants and either runs
the native filesystem handler or routes to a device if `target` names one. An
adapter can call `adapter.inbound`; the authoritative link resolves the external
actor and the owning user Kernel delivers the message to a process. A CLI call
to `gsv proc kill` becomes a `proc.kill` syscall forwarded to the target Process
DO after ownership checks.

The key architectural choice is that syscall names do not change based on where
they run. `fs.read` is still `fs.read` whether it reads from the cloud filesystem
or a connected laptop.

## Why Cloudflare

GSV needs to be reachable when no personal machine is online. Cloudflare Workers
provide the always-on edge entrypoint, Durable Objects provide serialized
stateful actors, R2 provides object storage, and service bindings connect the
Gateway, ripgit, assembler, adapters, and AppRunner without running a traditional
server.

The system uses multiple Durable Object roles instead of one monolith:

- Master Kernel DO: ship-wide identity, authorization, package/configuration,
  and provisioning authority. Admission remains closed and unimplemented.
- User Kernel DOs: per-human connections, syscall dispatch, devices, routes,
  schedules, OAuth/MCP state, and personal runtime coordination.
- Process DOs: durable agent loops and process-local SQLite.
- AppRunner control DOs
  (`app-control-v3:<kernelOwnerUid>:<actorUid>:<encodedPackageId>`): exact-bound
  package runtime state, RPC sessions, and daemon schedules.
- Package data DOs
  (`app-data-v2:<kernelOwnerUid>:<actorUid>:<encodedPackageId>`):
  package-reachable SQL, physically separated from AppRunner control tables.
- ripgit objects/workers: repository storage and Git protocol handling.

The v22 Kernel registry records only AppRunner control/data objects that have
successfully passed current authorization, binding the run-as package actor and
controlling human Kernel owner as distinct identities. The owner, actor, and
package jointly select the physical runner. Package and lifecycle transitions
advance a durable, never-reused local runtime epoch, close admission, abort
cancelable work, and wait for tracked wrappers in that observed set before
clearing Kernel admission. Opaque Loader RPC promises without a cancellation
handle are abandoned on abort and remain observed; their revoked epoch cannot
reacquire current platform authority. Pre-owner-qualified `app-control-v2:` and
`app-data:` objects, plus older combined `app:` SQL objects, remain unreachable
and are not automatically migrated.

The tradeoff is that the architecture must be explicit about routing, timeouts,
and state boundaries. Long-running local work should happen on devices. Durable
agent state belongs in Process SQLite and workspace files. Global control-plane
truth belongs in Master Kernel SQLite; per-human control-plane truth belongs in
that user Kernel. Opaque bytes belong in R2. Versioned work belongs in ripgit.

## Design Rules

GSV favors stable OS-like interfaces over implementation leakage.

- Agents should use paths and syscalls, not database names or storage buckets.
- Workspaces outlive processes; processes are execution, workspaces are durable
  artifacts.
- Devices are optional hardware. The cloud `gsv` target should remain useful
  even when no device is connected.
- Package capabilities are explicit grants, not ambient access.
- Repository history is part of the system model because agents and apps need
  source, diffs, review context, and distribution.

These rules are what make GSV feel like a cloud computer instead of a collection
of chat integrations.

## Multiuser deployment

Accounts inhabit one ship-wide identity and Unix permission namespace, with uid
`0` intentionally administering all of it. That global security domain does not
require one physical object to carry all runtime traffic. The implementation retains
`singleton` as the Master Control Program and provisions one
`user:<canonical-username>` Kernel for each login-capable human. Heavy execution
remains sharded into Process and AppRunner objects and target services. The
[Multiuser Security Architecture](./multiuser-security.md) defines the threat
model, migration contract, and release gates. Until that migration is complete,
the current implementation continues to route legacy traffic through
`singleton`, and public registration remains closed.

## See also

- [Get Started](../get-started/)
- [How-to Guides](../how-to/)
- [Reference](../reference/)
- [Multiuser Security Architecture](./multiuser-security.md)
