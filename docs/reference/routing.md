# Routing Reference

GSV routing is kernel-level message and syscall routing. It is not only chat
routing. The owning `user:<canonical-username>` Kernel is the central router for
one human's WebSocket clients, agent processes, package apps, adapter
deliveries, and connected devices. The Master Control Program named `singleton`
handles commissioning and global authority, including current account,
capability, package, configuration, repository, and adapter-link decisions.
Adapter frames traverse the Master in both directions today; other user payload
and execution data planes remain on their owning paths.

## Routing Surfaces

| Surface | Entry Point | Routed By | Destination |
|---|---|---|---|
| CLI or browser client | `/ws/<username>` WebSocket request frame | owning user Kernel, syscall name, caller capabilities, optional `target` | User-Kernel handler, Process DO, or device driver |
| Agent process | owning `Kernel.recvFrame(pid, frame)` | installed user-Kernel route, process identity, and syscall | User-Kernel handler or device driver |
| Package app | generationless session route locator, then owning `Kernel.appRequest(...)` | bounded username locator; target-local HMAC/session; live Master package/actor validation | User-Kernel handler, AppRunner, or device driver |
| Adapter worker | service-bound `adapter.inbound` through Gateway | Master identity-link decision, idempotent ensure for a known provisioning placement, then active target username/uid marker | Owning user Kernel, then init or routed Process |
| Device driver | owner-routed WebSocket response frame | persisted route id in the owning user Kernel | Original client, process, or app |

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

The owning user-Kernel dispatcher first checks `args.target`. If `target` is
omitted or set to `gsv`, the syscall is handled natively by that Kernel. If
`target` names a connected device and the syscall is routable, the user Kernel
forwards it to that device.

The `fs.*`, `shell.*`, and `net.*` domains support device routing. Other domains such as `sys.*`, `proc.*`, `pkg.*`, `repo.*`, `adapter.*`, and `notification.*` are kernel-internal.

```json
{ "path": "/etc/passwd", "target": "gsv" }
```

```json
{ "input": "git status --short", "cwd": "~/projects/gsv", "target": "laptop" }
```

Before forwarding to a device, the owning user Kernel checks:

- The caller can access the device by ownership, group ACL, or root.
- The device is online.
- The device advertises an `implements` capability matching the syscall.
- A live driver WebSocket exists for the device id.

Forwarded calls are stored in the owning user Kernel SQLite `routing_table` with
the call id, syscall, origin, target device, and timeout schedule. When the
device responds, that Kernel consumes the route and returns the response to the
original origin. If the route expires first, the origin receives a `504` timeout
response.

Shell continuations use a second durable session mapping. A routed shell start
that returns `status: "running"` records its `sessionId` and owning device.
Later `shell.exec` requests with that `sessionId` route to the same device even
when `target` is omitted. This keeps the model-facing Shell tool small while
preventing long-running commands from depending on one in-flight route.

`codemode.exec` is different: the user Kernel exposes it as an agent tool, but
the Process DO executes it locally with the Worker Loader instead of routing it
through the user-Kernel dispatcher. The manual `codemode.run` syscall is public
and user-Kernel-forwarded to a Process DO, which uses the same executor. CodeMode's
in-block `shell(...)`, `fs.*(...)`, and `fetch(...)` helpers call back into the
Process, which dispatches normal `shell.exec`, `fs.*`, and `net.fetch` request
frames through the owning user Kernel. Nested calls therefore use the same
capabilities, device routing, async responses, shell sessions, and agent
approval policy as direct tool calls.

## Process Routing

Agent conversations are durable processes, identified by PIDs. The long-lived home process for a user is `init:{uid}`. Other processes are spawned with `proc.spawn` and usually receive UUID PIDs.

The owning user Kernel stores process metadata in the `processes` table: owner
canonical username and uid, run-as identity, parent PID, cwd, interactive flag,
runtime state, active conversation/run ids, label, and context files. `proc.list`
is answered directly from this registry.

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

When no PID is supplied, process syscalls default to the caller's `init:{uid}` process. Non-root callers cannot access another user's process.

## Process Signal Routing

Process DOs emit lifecycle and output signals such as `proc.run.started`,
`proc.run.stream`, `proc.run.output`, `proc.run.hil.requested`, and
`proc.run.finished`. The owning user Kernel routes user-visible process signals using
`run_routes`; `proc.changed` invalidates persisted process state.

For CLI/browser-originated runs, `run_routes` maps `runId` to the originating WebSocket connection. For adapter-originated runs, it maps `runId` to the adapter, account id, surface kind, surface id, and optional thread id. Routes expire after 30 minutes.

If a run route is missing, the owning user Kernel falls back to broadcasting the
signal to its connected user clients. HIL requests are always broadcast to every
connected user client for the owning uid so another session can answer them.
Adapter-originated HIL requests are also delivered back to their adapter surface.

A Process persists its owning user-Kernel object name, human owner uid, and
run-as identity. The owning Kernel registry binds that PID to the same record.
Process RPCs, authority resolution, cancellation, queued signals, and post-I/O
results accept only the owning active user Kernel; a PID or frame-supplied
identity cannot authenticate a caller.

`proc.abort` cancels the active run while preserving queued input, history, and
media. `proc.reset` resets conversation state and `proc.kill` archives and tears
the Process down. Late output from cancelled or superseded work cannot mutate
the active run.

## Git HTTP Routing

Git HTTP does not route through a user Kernel. The Gateway asks `singleton` for
a bounded credential and repository admission decision. The Master applies the
durable abuse limit, performs bounded password-or-token verification, then
checks the exact username, uid, active placement, capabilities, repository
owner, and ACL. Unknown or non-active accounts receive generic verifier behavior
but no access as that identity; explicitly public reads may proceed anonymously.

After a successful decision, the Gateway forwards the original request directly
to RIPGIT. Git request bodies, packfiles, and response streams do not pass
through either Kernel.

## Adapter Routing

Messaging adapters call `adapter.inbound` through a service identity.
Adapter-specific normalization stays in the adapter worker. The Master Control
Program owns the authoritative adapter-account and identity-link tables and
routes adapter traffic in both directions. On inbound delivery, the scoped
Gateway entrypoint calls the Master with the normalized frame. The Master
validates bounded adapter/account/actor/surface fields and resolves the live
link. For a known `provisioning` owner placement it idempotently completes
provisioning, then invokes only the active user Kernel. The target verifies the
Master source and its own active username/uid marker before delivery.

Inbound behavior:

- Linked actor: resolve the local uid and deliver to a process.
- Unlinked DM actor: return a link challenge such as `gsv auth link CODE`.
- Unlinked non-DM actor: drop the message as `unlinked_actor`.

Unknown DMs receive a Master-generated linking challenge; unknown non-DM events
receive a compact drop response. Outbound replies return to the Master with the
stored run route. It rechecks the owner, adapter account, external actor,
surface, and monotonic link revision before invoking the adapter worker.

Adapter-backed `shell.exec` targets are separate from inbound message delivery.
Adapter-shell discovery and routing require their own explicit target and
capability decision; a messaging identity link alone does not grant shell
access.

The default delivery target is the user's `init:{uid}` process. A `surface_routes` entry can override this for a specific adapter account and surface:

```text
adapter + accountId + surface.kind + surface.id -> pid
```

Human-in-the-loop replies are routed specially. If the target process has a pending HIL request, a DM reply of approval or denial resumes `proc.hil` instead of starting a new chat turn.

## Package App Routing

Package UI and RPC calls are routed through package identity frames. The owning
user Kernel verifies:

- The package is installed and enabled.
- The route base and entrypoint match the installed manifest.
- The entrypoint grants the requested syscall.
- The user identity in the app frame is still valid.

The active app-session handle has the bounded form
`gsv1b~username~uid~expiresAt~nonce~signature`. The signature is a local
user-Kernel HMAC over the locator fields. The Gateway parses the canonical
username and bounds before selecting `user:<username>`. Waking that bounded
object is acceptable; the target requires its active marker, matching HMAC,
expiry, launch/client secret, and exact local session before granting access.

The active user Kernel asks the Master to validate the current run-as account,
enabled/reviewed package, artifact hash, entrypoint, and requested call. It then
routes to the deterministic `app:<actorUid>:<packageId>` AppRunner.
That name is a locator, not authority. AppRunner callbacks carry an exact app
frame and are reauthorized through the same user Kernel. App request bodies,
response streams, and package execution do not transit the Master.

Package app syscalls can use the same device routing path as clients and processes. Async device responses are held in memory as pending app responses until the device reply or timeout arrives.

## Device Routing

Devices are persistent records in the owner's user Kernel SQLite. A driver
connects through `/ws/<owner-username>` and registers a device id, owner uid,
owner gid, platform, version, and `implements` list. Within one Kernel's local
device registry, the access model is Linux-like:

- Root can use every device present in that Kernel's registry.
- The owner uid can use the device.
- Members of granted groups can use the device.

An owned-device call stays inside the caller's user Kernel. Cross-user target
discovery, a Master-issued group/ACL authority context, and forwarding to the
owner's user Kernel are not implemented yet. Consequently `user:root` also
cannot enumerate or route devices in another active user shard; foreign targets
fail closed. Implementing bounded cross-shard administration without making the
Master the body/response relay is a multiuser release gate.

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

## Related Stores

| Store | Purpose |
|---|---|
| `routing_table` | In-flight device-routed syscalls. |
| `shell_sessions` | Device ownership and lifecycle for resumable shell sessions. |
| `run_routes` | Routes process run signals back to connections or adapter surfaces. |
| `processes` | User-Kernel process registry and process ownership. |
| `devices`, `device_access` | Device catalog and group ACLs. |
| Master `identity_links` directory | Authoritative external adapter actor to immutable canonical username/uid mapping used for inbound and outbound delivery. |
| User-Kernel `surface_routes` | Adapter surface to process mapping. |

## See also

- [Guides](../how-to/)
- [Connect a Messenger](../how-to/messengers)
- [The Adapter Model](../architecture/adapter-model.md)
