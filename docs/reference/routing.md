# Routing Reference

GSV routing is kernel-level message and syscall routing. It is not only chat
routing. The owning `user:<canonical-username>` Kernel is the central router for
one human's WebSocket clients, agent processes, package apps, adapter
deliveries, and connected devices. The Master Control Program named `singleton`
handles global authority and provisioning, current package/configuration
operations, app-route verification, and adapter link/placement resolution.

> Clean commissioning and newly created human accounts use the per-user split.
> Accounts discovered by migration v16 remain explicitly `legacy` and continue
> through `singleton`; an automated state migration is not implemented yet.

## Routing Surfaces

| Surface | Entry Point | Routed By | Destination |
|---|---|---|---|
| CLI or browser client | `/ws/<username>` WebSocket request frame | owning user Kernel, syscall name, caller capabilities, optional `target` | User-Kernel handler, Process DO, or device driver |
| Agent process | owning `Kernel.recvFrame(pid, frame)` | installed user-Kernel route, process identity, and syscall | User-Kernel handler or device driver |
| Package app | certified session route locator, then owning `Kernel.appRequest(...)` | edge P-256 placement verification before DO selection; target-local HMAC/session, package manifest, entrypoint grants | User-Kernel handler, AppRunner, or device driver |
| Adapter worker | service-bound `adapter.inbound` through Gateway | Master identity-link and active placement lookup; target uid/generation check | Owning user Kernel, then init or routed process |
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

WebSocket and app routes bind the current user-Kernel generation. An explicit
lifecycle transition fences the target and invalidates that generation. A
Process persists its owning Kernel object name, while the owning Kernel registry
binds its PID to the exact generation. Process RPCs, authority resolution,
cancellation, queued signals, and post-I/O results reject a stale binding.

The target persists its non-active marker and fences local ingress before it
sends an exact lifecycle abort to every Process DO registered to the old
generation. Lifecycle abort cancels the active run but does not claim the next
queued turn or delete queued input, history, or media. On authorized activation,
only same-owner registry records from the exact immediate predecessor generation
may be rebound to the new generation. Activation failure re-fences and aborts
the activating generation while preserving its executors. Wiring credential
reset and destructive group changes to lifecycle transitions remains
release-gated migration work.

## Git HTTP Routing

Git HTTP does not route through a user Kernel. The Gateway asks `singleton` for
a bounded credential and repository-metadata admission decision. The Master
snapshots the active or explicit-legacy placement, joins the per-user lifecycle
barrier, performs bounded password-or-token verification, then rechecks the
exact placement and repository ACL. Closed or transitioning accounts receive
generic verifier behavior but no access as that identity; explicitly public
reads may still proceed anonymously.

After a successful decision, the Gateway forwards the original request directly
to RIPGIT. The admission decision is the lifecycle linearization point: a
transition prevents new admissions and waits for verifier work already in the
barrier, while a request admitted before it may complete in RIPGIT. Git request
bodies, packfiles, and response streams do not pass through either Kernel.

## Adapter Routing

Messaging adapters call `adapter.inbound` through a service identity.
Adapter-specific normalization stays in the adapter worker. The Master Control
Program owns the authoritative identity-link table and currently resolves the
normalized adapter, account, and external actor from bounded metadata on every
message. For a linked active owner it returns an exact, expiring, one-shot route
grant without receiving the payload. The Gateway sends the full frame directly
to the user Kernel; that target consumes the grant, rechecks current link
generation and placement at the Master, then rechecks local lifecycle before
delivery. Active-user and unlinked text, media, reply context, and full frames
never enter `singleton`; only an explicit `legacy` placement uses the old
relay.

Inbound behavior:

- Linked actor: resolve the local uid and deliver to a process.
- Unlinked DM actor: return a link challenge such as `gsv auth link CODE`.
- Unlinked non-DM actor: drop the message as `unlinked_actor`.

Unknown DMs receive a compact Master-generated linking challenge from actor and
surface metadata; unknown non-DM events receive a compact drop response.
Generation-bound projections that remove the remaining per-message Master
metadata lookup are a future optimization, not current behavior.

Adapter-backed `shell.exec` targets are separate from inbound message delivery.
The active user-Kernel projection does not yet include the authoritative adapter
account/status/link catalog used to discover those targets, so adapter-shell
target discovery and routing remain release-gated on the sharded path. Legacy
`singleton` behavior does not imply that an active user Kernel can discover the
same target.

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

The opaque active app-session handle binds canonical username, uid, Kernel
generation, expiry, nonce, and a Master-issued P-256 placement certificate into
a separate local user-Kernel HMAC. The Gateway verifies the certificate from
the internal public SPKI record before it selects `user:<username>`. A forged
locator therefore returns `404` without creating or waking a caller-selected
user DO. The selected target then requires its exact active marker, the matching
local HMAC and app session, owner, package, capabilities, expiry, and generation.

Generation-bearing app frames route directly to the named user Kernel and are
reauthorized there. A generation-less route must be an exact legacy UUID and
resolves through `singleton` only when that owner is explicitly `legacy`; it is
not an active-user fallback. Active app request bodies, response streams, and
AppRunner calls do not transit the Master.

The v21 package-projection fence prevents app or package-agent work from running
across mixed Master projection revisions. The v22 actually-used AppRunner
registry binds each authorized control/data runner to its exact package actor
and controlling human Kernel owner. The Kernel owner, run-as actor, and package
jointly determine the owner-qualified
`app-control-v3:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` or
`app-data-v2:<kernelOwnerUid>:<actorUid>:<encodedPackageId>` name; the Kernel
owner determines fence authority. Package and lifecycle transitions use that
registry to persist a new runtime epoch, close admission, abort tracked
cancelable work, and wait for tracked wrappers to release before Kernel
admission clears. Uncancelable Loader promises are abandoned on abort and
cannot use their revoked epoch to reacquire current platform authority. An
unused deterministic object name is never instantiated merely for enumeration.

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
| Master `identity_links` directory | Authoritative external adapter actor to immutable canonical username/uid mapping used for each inbound lookup. |
| User-Kernel `surface_routes` | Adapter surface to process mapping. |

## See also

- [Guides](../how-to/)
- [Connect a Messenger](../how-to/messengers)
- [The Adapter Model](../architecture/adapter-model.md)
