# Architecture Overview

GSV is a personal cloud computer: an always-on operating system for humans,
machines, and agents. It runs on Cloudflare, but it is intentionally modeled like
a Linux-like computer rather than a chatbot backend. Users have identities,
agents are processes, storage is exposed as a filesystem, capabilities are
reached through syscalls, and external machines appear as devices.

This is a mental model, not POSIX compatibility. The point is to give humans and
AI processes familiar operating-system affordances: inspectable files, stable
paths, process IDs, permissions, device targets, packages, and command surfaces.

## The Current Pillars

### Kernel

The Gateway Worker and Kernel Durable Object are the GSV kernel. The Worker owns
HTTP/WebSocket entrypoints; the Kernel DO is the serialized control plane behind
them.

The Kernel is responsible for:

- Authenticating users, service identities, and device drivers.
- Maintaining users, groups, tokens, capabilities, devices, packages, adapter
  links, workspaces, routes, notifications, and runtime config in Kernel SQLite.
- Dispatching syscalls such as `fs.read`, `shell.exec`, `proc.spawn`,
  `pkg.sync`, `sys.config.get`, and `adapter.inbound`.
- Routing requests between browser clients, the CLI, package apps, Process DOs,
  adapter workers, and connected devices.

The Kernel is deliberately the place where policy lives. Process DOs run agents,
AppRunner DOs run package code, and devices execute local hardware work, but the
Kernel decides whether a caller is allowed to do something and where the request
should go.

### Agent Processes

Agents are durable processes, not sessions. Each user has a long-lived init
process, `init:{uid}`, and can spawn child processes with `proc.spawn`. A process
has a PID, uid/gid identity, parent, profile, current working directory, optional
workspace, state, and persistent message history.

Process state lives in a Process Durable Object with its own SQLite database.
That database stores active messages, pending tool calls, queued messages,
human-in-the-loop state, and process-local metadata. The Kernel registry stores
the process metadata needed for routing and permissions.

The agent loop belongs to the Process DO. It assembles context, calls the model,
receives tool calls, issues syscalls, waits for results, and emits `chat.*`
signals back through the Kernel. `gsv chat` is therefore just one client for a
process; browser apps and adapters can target the same process model.

### Filesystem and Storage

GSV exposes a virtual filesystem through `GsvFs`. Agents and apps interact with
paths such as `/home/alice`, `/workspaces/{workspaceId}`, `/sys`, `/proc`,
`/dev`, `/etc`, `/src/package`, and `/usr/local/bin` instead of storage APIs.

Different path families are backed by different stores:

- Kernel SQLite backs control-plane paths such as `/sys`, `/proc`, `/dev`, and
  auth/config overlays in `/etc`.
- Process SQLite backs active conversation and run state.
- R2 stores ordinary bytes, process media, archives, package artifacts, and CLI
  download mirrors.
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
{ "deviceId": "macbook", "implements": ["fs.*", "shell.exec"] }
```

Agents always see the same tool names: `Read`, `Write`, `Edit`, `Delete`,
`Search`, and `Shell`. The `target` argument selects where the syscall runs.
`target: "gsv"` uses the native cloud implementation inside the Worker sandbox.
`target: "macbook"` routes the same `fs.*` or `shell.exec` syscall to that
device after ownership, group ACL, online-state, and capability checks.

This is the hardware abstraction layer. Devices can be laptops, servers, or any
CLI-run machine, but agents do not need a different API for each one.

### Packages and Apps

Packages are GSV software. A package declares a manifest, source repository,
entrypoints, and requested capabilities. Entry points can be browser UI, backend
HTTP/RPC, CLI commands, or package profiles.

Package source is resolved from ripgit, assembled by the assembler worker, stored
as an immutable artifact in R2, and executed by AppRunner Durable Objects.
AppRunner gives package code a scoped runtime with:

- Kernel access through the package SDK.
- Package-scoped SQLite.
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
- `root/gsv` can mirror the deployed GSV source.
- Package source repositories provide installable apps and CLI commands.

This is how GSV can host its own source, install packages from repos, and expose
public package metadata to other GSVs. Distribution is repository-based rather
than registry-only: a package is source plus manifest plus assembled artifact.

## How Requests Move

A typical chat request follows this path:

```text
CLI, browser, or adapter
  -> Gateway Worker
  -> Kernel DO
  -> Process DO
  -> model call
  -> syscall request
  -> Kernel dispatch
  -> native handler, Process DO, AppRunner, or device driver
  -> response
  -> Process DO continues the run
  -> chat.* signals return through Kernel run routing
  -> original client or adapter surface
```

The same dispatcher handles non-chat requests. A package app can issue
`fs.read`; the Kernel checks the package entrypoint grants and either runs the
native filesystem handler or routes to a device if `target` names one. An adapter
can call `adapter.inbound`; the Kernel resolves the external actor through
identity links and delivers the message to a process. A CLI call to `gsv proc
kill` becomes a `proc.kill` syscall forwarded to the target Process DO after
ownership checks.

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

- Kernel DO: authoritative control plane and router.
- Process DOs: durable agent loops and process-local SQLite.
- AppRunner DOs: package runtime state, RPC sessions, daemon schedules, and
  package SQL.
- ripgit objects/workers: repository storage and Git protocol handling.

The tradeoff is that the architecture must be explicit about routing, timeouts,
and state boundaries. Long-running local work should happen on devices. Durable
agent state belongs in Process SQLite and workspace files. Control-plane truth
belongs in Kernel SQLite. Opaque bytes belong in R2. Versioned work belongs in
ripgit.

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
