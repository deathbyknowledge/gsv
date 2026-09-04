# Routing Reference

GSV routing is kernel-level message and syscall routing. It is not only chat routing. The Kernel Durable Object is the central router for WebSocket clients, agent processes, adapter workers, and connected devices.

The installation route also scopes Ripgit. The Gateway overwrites Ripgit's
internal installation metadata after resolving the request hostname and strips
caller-provided values from public Git requests. Ripgit maps logical
`{owner}/{repo}` slugs to installation-specific Repository Durable Objects.
The standalone `singleton` route retains the historical `{owner}/{repo}` name.

Managed adapter service-binding RPC carries the same trusted installation
identity in both directions. Gateway-to-adapter calls derive it from the Kernel
context; adapter-to-Gateway calls normally recover it from the owning account
Durable Object's immutable name. Every call carries the context explicitly;
standalone uses `{installationId: "singleton"}`. Managed adapter account objects
use a collision-free internal name derived from `{installationId, accountId}`.
`singleton` retains the historical account object name for standalone upgrades.
Public webhook payloads and adapter frame arguments cannot choose this identity.
Standalone Telegram retains its
historical per-installation account objects and webhook paths. The managed
platform bot instead reaches a peer object chosen only from the authenticated
Telegram private actor. That object owns the active installation, local uid,
and route generation; public payloads cannot select any of them.

Managed lifecycle routing uses two directory lookups with different trust
inputs. Public HTTP resolves an accepted hostname, while durable adapter,
Kernel, Process, and scheduler paths resolve their already-owned immutable
`installationId`. Only `active` installations admit ordinary work.
`restricted` keeps the directory reservation and stored state but blocks new
admissions; paused Process ticks and due schedules periodically recheck for
reactivation.

## Routing Surfaces

| Surface | Entry Point | Routed By | Destination |
|---|---|---|---|
| CLI or browser client | WebSocket request frame | syscall name, caller capabilities, optional `target` | Kernel handler or target provider |
| Agent process | `Kernel.recvFrame(pid, frame)` | process identity and syscall | Kernel handler or target provider |
| Adapter worker | `adapter.inbound` syscall | linked actor identity, Ship selection, or shared-surface route | Personal controller or routed work/surface process |
| Device driver | WebSocket response frame | persisted route id | Original client or process |

All requests use the same frame shape:

```json
{
  "type": "req",
  "id": "call-id",
  "call": "fs.read",
  "args": { "path": "/home/alice/context.d/00-role.md" }
}
```

## Syscall Routing

The dispatcher first checks `args.target`. If `target` is omitted or set to
`gsv`, a target-routable syscall runs in GSV's native capability environment.
If `target` names a registered external target and the syscall is routable, the
Kernel forwards the unchanged syscall to that provider.

The native provider is an in-process implementation, not a synthetic peer or
device record. It owns only `fs.*`, `shell.exec`, and `net.fetch`; the Kernel
continues to own control-plane dispatch.

The `fs.*`, `shell.*`, and `net.*` domains support target routing. Other domains
such as `sys.*`, `proc.*`, `repo.*`, `adapter.*`, and `signal.*` are Kernel
control-plane interfaces rather than target operations.

```json
{ "path": "/etc/passwd", "target": "gsv" }
```

```json
{ "input": "git status --short", "cwd": "~/projects/gsv", "target": "laptop" }
```

Before forwarding to a device, the Kernel checks:

- The caller can access the device by ownership, group ACL, or root.
- The device is online.
- The device advertises an `implements` capability matching the syscall.
- A live driver WebSocket exists for the device id.

Forwarded calls are stored in the Kernel SQLite `routing_table` with the call id, syscall, origin, target device, and timeout schedule. When the device responds, the Kernel consumes the route and returns the response to the original origin. If the route expires first, the origin receives a `504` timeout response.

Shell continuations use a second durable session mapping. A routed shell start
that returns `status: "running"` records its `sessionId` and owning device.
Later `shell.exec` requests with that `sessionId` route to the same device even
when `target` is omitted. This keeps the model-facing Shell tool small while
preventing long-running commands from depending on one in-flight route.

`codemode.exec` is different: the Kernel exposes it as an agent tool, but the
Process DO executes it locally with the Worker Loader instead of routing it
through the Kernel dispatcher. The manual `codemode.run` syscall is public and
kernel-forwarded to a Process DO, which uses the same executor. CodeMode's
in-block `shell(...)`, `fs.*(...)`, and `fetch(...)` helpers call back into the
Process, which dispatches normal `shell.exec`, `fs.*`, and `net.fetch` request
frames through the Kernel. Nested calls therefore use the same capabilities,
target routing, async responses, shell sessions, and agent approval policy as
direct tool calls.

## Process Routing

Each durable agent task is a process identified by a PID. `proc.spawn` creates a
new process, and `proc.fork` creates a new process initialized from committed
history in another process. Each human owner has exactly one interactive,
top-level process marked as the personal controller. That process is the
default personal-intelligence destination across Web, CLI, Telegram, WhatsApp,
and other linked private surfaces. Explicit task and shared-surface processes
remain ordinary, separate processes; there is no second process-local
conversation identifier.

PIDs are installation-local. Process Durable Object lookups combine the
trusted installation ID with the PID in one canonical Durable Object name for
managed installations. The standalone `singleton` installation retains the
historical raw PID as its Durable Object name. Each Process derives both
immutable identifiers from that name; routing identity is not persisted
separately or repeated in delivered frames.

The Kernel stores process metadata in the `processes` table: owner uid, run-as
identity, parent PID, cwd, interactive flag, runtime state, active run id,
and label. `proc.list` is answered directly from this registry.

These syscalls are forwarded to the target Process DO after ownership checks:

```text
proc.send
proc.abort
proc.hil
proc.kill
proc.history
proc.reset
codemode.run
```

A request from a Process DO may omit its PID to target the calling process.
Callers outside a process must select a PID explicitly. Non-root callers cannot
access another user's process.

## Process Signal Routing

Process DOs emit lifecycle and output signals such as `proc.run.started`,
`proc.run.stream`, `proc.run.output`, `proc.run.hil.requested`, and
`proc.run.finished`. Every user-visible process signal is broadcast exactly
once to every connected user client for the owning uid. `run_routes` separately
owns exact adapter delivery and terminal cleanup. It turns routed committed
Messages and HIL requests into targeted `adapter.send` requests; `proc.changed`
invalidates persisted process state.

For CLI/browser-originated runs, `run_routes` maps `runId` to the originating WebSocket connection. For adapter-originated runs, it also binds the route to the process, owner, linked actor, adapter account, surface, optional thread, triggering message id, and managed peer-route generation. Delayed output and activity such as typing indicators are accepted only while that exact generation remains linked, so relinking the same external identity to the same user still fences work admitted before the relink. Terminal cleanup normally removes routes; the 30-day TTL is only a leak guard.

An authenticated linked private DM records one owner-scoped, last-active
adapter destination using the provider message timestamp, so an out-of-order
replay cannot replace newer activity; future timestamps are clamped to receipt
time so they cannot freeze the pointer. If a canonical personal-controller run
has no exact route, its terminal result or HIL prompt falls back to that
destination. Exact connection or adapter routes always win, and authorization
is rechecked at delivery. A Web-originated run therefore remains Web-only, and
a background run with no private destination remains visible in connected
clients and process history without guessing a transport.

## Adapter Routing

Messaging adapters call `adapter.inbound` through a service identity. The Kernel normalizes the adapter id and account id, then resolves the external actor id through `identity_links`.

An adapter's transport projection is not automatically a target. The bundled
adapters are currently absent from `sys.target.*` and the generic target
inventory because they do not implement the target contract. Explicit outbound
delivery resolves an opaque authorized surface from `message destinations`;
adapter account status and administration remain on the `adapter.*`
control-plane API. A future adapter account may independently expose a target
without changing these messaging semantics.

The native `message route` command exposes surface mappings without requiring
adapter-specific fields. It resolves `here`, opaque destination ids, or
unambiguous labels, and can show or list routing. Set and clear manage group,
channel, and thread routes. The canonical personal process may also use set to
open a private-DM direct line, but only from the exact latest run on that DM and
only to an owned interactive non-personal process. DM clear remains the human's
unconditional `/ship` action.

Inbound behavior:

- Linked actor: resolve the local uid and deliver to a process.
- Unlinked DM actor: return a link challenge such as `gsv auth link CODE`.
- Unlinked non-DM actor: drop the message as `unlinked_actor`.

A `surface_routes` entry selects the process for one linked actor on an exact
adapter account, surface, and optional thread:

```text
adapter + accountId + actorId + surface.kind + surface.id + threadId -> uid + pid
```

No private-DM row means SHIP: the message resolves the owner's
canonical personal controller without persisting a default surface route.
When the user asks for a direct line, that controller selects the work process
with `message route set`; the current personal answer confirms the transition,
and the next inbound message enters the explicit `work` override. The command
requires its immutable run route to match the latest linked private activity
and the newest Kernel ingress receipt for that DM. Later activity or selection
therefore fences a slow tool call even when provider timestamps arrive out of
order. Repeating the same run-and-target handoff is idempotent. `/ship` clears
the override immediately,
even while the work process is active, and admits a typed return event to the
personal process with the work PID but no copied transcript. Exact run routes
still return late work output to its originating DM with a
`[WORK SESSION]` label. A late personal reply is labeled
`[PERSONAL INTELLIGENCE]` when that DM currently selects work.

Groups, channels, and threads retain distinct persisted `surface` routes. An
unrouted shared surface starts an ordinary interactive process running as the
owner's personal agent and binds that actor-scoped surface to it.

Migration v023 adds the canonical personal-process slot. Migration v024
classifies pre-upgrade DM rows as `legacy`. A legacy DM drains
through its old process while it is active, queued, or waiting for HIL, then is
cleared on idle and returns to Ship. Checkpointed ingress recovery always uses its
recorded PID and never rewrites a private-DM selection.

Migration v025 stores the owner's latest linked private destination together
with its winning provider message id for the personal-output fallback pointer.
Independent Kernel ingress-receipt order completes the stale-handoff fence.
Migration v032 adds the managed peer-route generation to exact adapter run
routes so committed output cannot cross a later relink.

Human-in-the-loop delivery uses the same exact structured request as native
clients. Clients receive `proc.run.hil.requested`; the exact adapter route
receives a targeted `adapter.send` carrying its `ProcHilRequest` and renders
native controls or, when secure controls are unavailable, a safe handoff to
Chat. Opaque request identities never appear in user-facing text. A native callback retains
the Process, run, request, linked actor, surface, route generation, and provider
message correlation. It reaches the Kernel through `linkedPeerFrame`; the
Kernel derives an interaction-scoped human peer, intersects the linked user's
grant with `proc.hil`, rechecks destination authority and the pending request,
and enters the ordinary dispatcher. Stale or relinked callbacks fail closed.
Provider reply threading does not authorize a decision, and the adapter service
principal never receives direct `proc.hil` authority.


## Registered Target Routing

Registered external targets are currently persisted as device records in Kernel
SQLite. A driver connection registers a device id, owner uid, owner gid,
platform, version, and `implements` list. The access model is Linux-like:

- Root can use every device.
- The owner uid can use the device.
- Members of granted groups can use the device.

Target routing does not rename syscalls. Agents and clients always see the same
syscall names, such as `fs.read` and `shell.exec`; `target` selects whether the
initial call runs on `gsv` or a registered provider. For shell continuations,
`sessionId` selects the environment that owns the previously started session.

## Failure Behavior

| Failure | Result |
|---|---|
| Missing capability | `403 Permission denied` |
| Device access denied | `403 Access denied to device` |
| Device offline | `503 Device offline` |
| No active device connection | `503 No active connection` |
| Device does not implement syscall | `400 Device does not implement` |
| Device route timeout | `504 Syscall timed out` |
| Unknown or foreign process | `Process not found` or `Permission denied` |
| Adapter installation mismatch | Adapter RPC fails before account state or provider access |
| Managed installation suspended | New HTTP routes return `404`; existing RPC/WebSocket admissions return `423` |

## Related Stores

| Store | Purpose |
|---|---|
| `routing_table` | In-flight device-routed syscalls. |
| `shell_sessions` | Device ownership and lifecycle for resumable shell sessions. |
| `run_routes` | Retains the exact connection endpoint or adapter destination for a process run. |
| `processes` | Kernel process registry and process ownership. |
| `devices`, `device_access` | Device catalog and group ACLs. |
| `identity_links` | External adapter actor to local uid mapping. |
| `surface_routes` | Explicit work overrides and actor-scoped shared-surface mappings. |
| `private_adapter_destinations` | One owner-scoped last-active linked DM for route-less personal output. |

## See also

- [Guides](../how-to/)
- [Connect a Messenger](../how-to/messengers)
- [The Adapter Model](../architecture/adapter-model.md)
