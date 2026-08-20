# Architecture Overview

GSV is a personal cloud computer: an always-on operating system for humans,
machines, and agents. It runs on Cloudflare, but it is intentionally modeled like
a Linux-like computer rather than a chatbot backend. Users have identities,
agents are processes, storage is exposed as a filesystem, capabilities are
reached through syscalls, and external machines appear as devices.

This is a mental model, not POSIX compatibility. The point is to give humans and
AI processes familiar operating-system affordances: inspectable files, stable
paths, process IDs, permissions, device targets, repositories, and command surfaces.

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

## The Current Pillars

### Kernel

The Gateway Worker and Kernel Durable Object are the GSV kernel. The Worker owns
HTTP/WebSocket entrypoints; the Kernel DO is the serialized control plane behind
them.

The Kernel is responsible for:

- Authenticating users, service identities, and device drivers.
- Maintaining users, groups, tokens, OAuth accounts, capabilities, devices,
  adapter links, workspaces, routes, and runtime config
  in Kernel SQLite.
- Dispatching syscalls such as `fs.read`, `shell.exec`, `proc.spawn`,
  `repo.apply`, `sys.config.get`, `sys.oauth.start`, `sys.mcp.add`, and
  `adapter.inbound`.
- Routing requests between browser clients, the CLI, Process DOs,
  adapter workers, and connected devices.

The Kernel is deliberately the place where policy lives. Process DOs run agents
and devices execute local hardware work, but the Kernel decides whether a caller
is allowed to do something and where the request should go.

### Agent Processes

Agents are durable processes, not sessions. Each body of work has its own
process, created with `proc.spawn` or `proc.fork`. A process has a PID, uid/gid
identity, parent, profile, current working directory, optional workspace, state,
and persistent message history.

Each human has one personal agent account that acts as their personal
intelligence, plus one current personal process where direct conversations and
user-level events converge. The Kernel records that role explicitly; it is not
inferred from recency, labels, or account name. Its pid remains replaceable and
ordinary. Custom agent accounts provide specialized identities when explicitly
selected. A delegated child inherits its parent's account by default and acts
in a bounded worker role; other processes remain visible work rather than
alternative personal intelligences.

Process state lives in a Process Durable Object with its own SQLite database.
That database stores active messages, pending tool calls, queued messages,
human-in-the-loop state, and process-local metadata. The Kernel registry stores
the process metadata needed for routing and permissions.

The agent loop belongs to the Process DO. It assembles context, calls the model,
receives tool calls, issues syscalls, waits for results, and emits `proc.run.*`
and `proc.changed` signals through the Kernel. `gsv chat` is therefore just one
client for a process; browser clients and adapters can reach the same process
model.

### Filesystem and Storage

GSV exposes a virtual filesystem through `GsvFs`. Agents and clients interact with
paths such as `/home/alice`, `/workspaces/{workspaceId}`, `/sys`, `/proc`,
`/var`, `/dev`, `/etc`, `/src/repos`, and `/usr/local/bin` instead of storage
APIs.

Different path families are backed by different stores:

- Kernel SQLite backs control-plane paths such as `/sys`, `/proc`, `/dev`, and
  auth/config overlays in `/etc`.
- Process SQLite backs history and run state.
- R2 stores ordinary bytes, process media, and archives.
- ripgit stores versioned home knowledge, workspace trees, and repository content.

This split matters operationally, but it should be hidden from agents whenever
possible. The filesystem is the stable interface.

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
CLI-run machine, but agents do not need a different API for each one.

The Android wearable target follows the same device contract while keeping
camera ownership, Wear Mode authority, and reconnect behavior on the phone.
See [Android Wear Runtime](./android-wear-runtime.md) for that state machine and
its virtual hardware paths.

Messaging adapters are deliberately outside this target inventory. They do not
execute targetable syscalls and therefore do not appear as devices or available
targets. Agents discover authorized messaging surfaces with
`message destinations`; users inspect and administer adapter accounts in the
Messengers console and adapter APIs.

### Git and Distribution

ripgit is GSV's built-in Git service and repository API. It supports Git HTTP
paths for clone/fetch/push and an internal `/hyperspace/repos/...` API used by
the Kernel for reads, writes, search, and upstream
imports.

Repository slugs are installation-local. The Gateway binds internal Ripgit
requests to the resolved installation, and Ripgit includes that identity in
the physical Repository Durable Object name. Public Git paths remain
`/git/{owner}/{repo}.git`; standalone deployments retain the historical
`{owner}/{repo}` object names.

GSV uses repositories for more than source control:

- `{username}/home` stores user-global knowledge and context.
- `{username}/{workspaceId}` stores workspace files and checkpoints.
- `root/gsv-manual` stores the imported product manual.
This keeps system documentation and user-owned knowledge inspectable while
supporting ordinary repository workflows without an external Git service.

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
  -> native handler, Process DO, or device driver
  -> response
  -> Process DO continues the run
  -> proc.run.* signals return through Kernel run routing
  -> original client or adapter surface
```

The same dispatcher handles non-chat requests. A client can issue `fs.read`;
the Kernel checks its identity and capabilities, then either runs the native
filesystem handler or routes to a device if `target` names one. An adapter can
call `adapter.inbound`; the Kernel resolves the external actor through identity
links and delivers the message to a process. A CLI call to `gsv proc kill`
becomes a `proc.kill` syscall forwarded to the target Process DO after ownership
checks.

The key architectural choice is that syscall names do not change based on where
they run. `fs.read` is still `fs.read` whether it reads from the cloud filesystem
or a connected laptop.

## Why Cloudflare

GSV needs to be reachable when no personal machine is online. Cloudflare Workers
provide the always-on edge entrypoint, Durable Objects provide serialized
stateful actors, R2 provides object storage, and service bindings connect the
Gateway, ripgit, and adapters without running a traditional
server.

The system uses multiple Durable Object roles instead of one monolith:

- Kernel DO: authoritative control plane and router.
- Process DOs: durable agent loops and process-local SQLite.
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
- Repository history is part of the system model because agents need source,
  diffs, review context, and durable collaboration.

These rules are what make GSV feel like a cloud computer instead of a collection
of chat integrations.

## See also

- [Get Started](../get-started/)
- [How-to Guides](../how-to/)
- [Reference](../reference/)

## Deferred design proposals

- [Resource References and Lazy Binary Resolution](./resource-references.md)
  records the proposed common file-reference contract for machines, clients,
  adapters, model context, and durable GSV retention. It replaces eager media
  copying with lazy binary resolution and is intentionally not implemented yet.
- [Unified Protocol Peers](./unified-protocol-peers.md) records the proposed
  shared syscall, command, and exact-output model for WebSocket clients and
  service-bound adapters. It is intentionally deferred until managed staging
  and the native application are stable.
- [Universal Routing Graph and Surface Bindings](./interaction-surface-bindings.md)
  explores durable Process bindings and output graphs. It is also design-only
  and is not a prerequisite for the unified peer model.
