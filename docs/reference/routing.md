# Routing Reference

GSV routing is kernel-level message and syscall routing. It is not only chat routing. The Kernel Durable Object is the central router for WebSocket clients, agent processes, adapter workers, and connected devices.

## Installation Routing

Installation identity is the outer routing boundary. In managed mode, the
Gateway normalizes the request hostname and asks the trusted installation
directory for an active installation before opening any Durable Object. An
unknown, suspended, provisioning, or deleted hostname returns `404`; a random
wildcard hostname does not allocate a Kernel.

The directory returns an immutable `installationId`, handle, and persisted
canonical origin. The Kernel Durable Object is named by `installationId`.
Handles and hostnames are routing metadata and may not be substituted for that
durable identity. Standalone deployments explicitly route to the compatibility
installation `singleton`, preserving the historical Kernel object. That ID is
reserved: a managed directory result naming `singleton` is rejected before any
Durable Object lookup.

The same trusted route scopes ripgit. Installation-local code receives a
binding that overwrites ripgit's internal installation header, and the public
Git proxy removes any caller-supplied value before forwarding. ripgit maps the
logical `{owner}/{repo}` to the managed Repository Durable Object name
`{installationId}/{owner}/{repo}`. The `singleton` compatibility route retains
the historical `{owner}/{repo}` name, so existing standalone repositories do
not move on upgrade.

Adapter service-binding RPC carries the same trusted installation identity in
both directions. Gateway-to-adapter calls derive it from the Kernel context;
adapter-to-Gateway calls recover it from the owning account Durable Object.
Managed adapter account objects use a collision-free internal name derived
from `{installationId, accountId}` and persist the installation ID as an
ownership assertion. `singleton` retains the historical unscoped account
object name for standalone upgrades. Public webhook payloads and adapter frame
arguments cannot choose this identity. Managed Telegram webhook routes use an
opaque Durable Object ID, while legacy standalone webhook paths keep their
existing account identifier.

## Routing Surfaces

| Surface | Entry Point | Routed By | Destination |
|---|---|---|---|
| CLI or browser client | WebSocket request frame | syscall name, caller capabilities, optional `target` | Kernel handler, Process DO, or device driver |
| Agent process | `Kernel.recvFrame(pid, frame)` | process identity and syscall | Kernel handler or device driver |
| Adapter worker | `adapter.inbound` syscall | linked actor identity and surface route | Routed process or a newly created personal-agent process |
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

The dispatcher first checks `args.target`. If `target` is omitted or set to `gsv`, the syscall is handled natively by the Kernel. If `target` names a connected device and the syscall is routable, the Kernel forwards it to that device.

The `fs.*`, `shell.*`, and `net.*` domains support device routing. Other domains such as `sys.*`, `proc.*`, `repo.*`, `adapter.*`, and `signal.*` are kernel-internal.

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
device routing, async responses, shell sessions, and agent approval policy as
direct tool calls.

## Process Routing

Each durable agent task is a process identified by a PID. `proc.spawn` creates a
new process, and `proc.fork` creates a new process initialized from committed
history in another process. There is no default process or second
process-local conversation identifier.

The PID is installation-local. Internally, every Process lookup carries both
the trusted Kernel installation ID and the public PID. Managed Process Durable
Object names use a canonical encoding of both values; the `singleton`
compatibility installation keeps the historical unscoped PID name. A Process
persists its parent installation ID during `proc.setidentity` and rejects a
later frame routed with a different installation.

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
`proc.run.finished`. The Kernel routes user-visible process signals using
`run_routes`; `proc.changed` invalidates persisted process state.

For CLI/browser-originated runs, `run_routes` maps `runId` to the originating WebSocket connection. For adapter-originated runs, it also binds the route to the process, owner, linked actor, adapter account, surface, optional thread, and triggering message id. Terminal cleanup normally removes routes; the 30-day TTL is only a leak guard.

If a run route is missing, the Kernel falls back to broadcasting the signal to connected clients for the owning uid. HIL requests are always broadcast to every connected user client for the owning uid so another session can answer them. Adapter-originated HIL requests are also delivered back to their adapter surface.

## Adapter Routing

Messaging adapters call `adapter.inbound` through a service identity. The Kernel normalizes the adapter id and account id, then resolves the external actor id through `identity_links`.

An adapter is a transport service, not a device target. It is absent from
`sys.device.*`, target-aware tool schemas, and the generic target inventory.
Explicit outbound delivery resolves an opaque authorized surface from
`message destinations`; adapter account status and administration remain on
the `adapter.*` control-plane API.

Inbound behavior:

- Linked actor: resolve the local uid and deliver to a process.
- Unlinked DM actor: return a link challenge such as `gsv auth link CODE`.
- Unlinked non-DM actor: drop the message as `unlinked_actor`.

A `surface_routes` entry selects the process for one linked actor on an exact
adapter account, surface, and optional thread:

```text
adapter + accountId + actorId + surface.kind + surface.id + threadId -> uid + pid
```

When no route exists, the first admitted message creates a process that runs as
the user's personal agent and binds that surface to its PID. Later messages
reuse the route. Selecting `/use personal` creates and routes to a new
personal-agent process; selecting an existing PID updates the route.

Human-in-the-loop replies are routed specially. If the target process has a
pending HIL request, its adapter DM prompt includes `hil[requestId]`. Only an
approval or denial containing that exact current token resumes `proc.hil`;
bare decisions and stale tokens fail closed. Provider reply threading does not
authorize a decision.


## Device Routing

Devices are persistent records in Kernel SQLite. A driver connection registers a device id, owner uid, owner gid, platform, version, and `implements` list. The access model is Linux-like:

- Root can use every device.
- The owner uid can use the device.
- Members of granted groups can use the device.

Device routing does not rename syscalls. Agents and clients always see the same syscall names, such as `fs.read` and `shell.exec`; `target` selects whether the initial call runs on `gsv` or a device. For shell continuations, `sessionId` selects the previously started shell session.

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
| Unknown or inactive managed hostname | `404 Not Found` before Kernel lookup |
| Process installation mismatch | `409` and no Process state mutation |
| Adapter installation mismatch | Adapter RPC fails before account state or provider access |

## Related Stores

| Store | Purpose |
|---|---|
| `routing_table` | In-flight device-routed syscalls. |
| `shell_sessions` | Device ownership and lifecycle for resumable shell sessions. |
| `run_routes` | Routes process run signals back to connections or adapter surfaces. |
| `processes` | Kernel process registry and process ownership. |
| `devices`, `device_access` | Device catalog and group ACLs. |
| `identity_links` | External adapter actor to local uid mapping. |
| `surface_routes` | Adapter surface to process mapping. |

## See also

- [Guides](../how-to/)
- [Connect a Messenger](../how-to/messengers)
- [The Adapter Model](../architecture/adapter-model.md)
