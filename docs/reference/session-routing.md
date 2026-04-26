# Routing Reference

GSV routing is kernel-level message and syscall routing. It is not only chat/session routing. The Kernel Durable Object is the central router for WebSocket clients, agent processes, package apps, adapter workers, and connected devices.

## Routing Surfaces

| Surface | Entry Point | Routed By | Destination |
|---|---|---|---|
| CLI or browser client | WebSocket request frame | syscall name, caller capabilities, optional `target` | Kernel handler, Process DO, or device driver |
| Agent process | `Kernel.recvFrame(pid, frame)` | process identity and syscall | Kernel handler or device driver |
| Package app | `Kernel.appRequest(...)` | app frame, package manifest, entrypoint grants | Kernel handler or device driver |
| Adapter worker | `adapter.inbound` syscall | linked actor identity and surface route | User init process or routed process |
| Device driver | WebSocket response frame | persisted route id | Original client, process, or app |

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

Only `fs.*` and `shell.exec` support device routing. Other domains such as `sys.*`, `proc.*`, `pkg.*`, `repo.*`, `adapter.*`, and `notification.*` are kernel-internal.

```json
{ "path": "/etc/passwd", "target": "gsv" }
```

```json
{ "command": "git status --short", "target": "laptop" }
```

Before forwarding to a device, the Kernel checks:

- The caller can access the device by ownership, group ACL, or root.
- The device is online.
- The device advertises an `implements` capability matching the syscall.
- A live driver WebSocket exists for the device id.

Forwarded calls are stored in the Kernel SQLite `routing_table` with the call id, syscall, origin, target device, and timeout schedule. When the device responds, the Kernel consumes the route and returns the response to the original origin. If the route expires first, the origin receives a `504` timeout response.

## Process Routing

Agent conversations are durable processes, identified by PIDs. The long-lived home process for a user is `init:{uid}`. Other processes are spawned with `proc.spawn` and usually receive UUID PIDs.

The Kernel stores process metadata in the `processes` table: uid, gids, profile, parent PID, cwd, workspace id, source mounts, state, label, and context files. `proc.list` is answered directly from this registry.

These syscalls are forwarded to the target Process DO after ownership checks:

```text
proc.send
proc.abort
proc.hil
proc.kill
proc.history
proc.reset
```

When no PID is supplied, process syscalls default to the caller's `init:{uid}` process. Non-root callers cannot access another user's process.

## Chat Signal Routing

Process DOs emit chat signals such as `chat.delta`, `chat.tool_result`, `chat.hil`, and `chat.complete`. The Kernel routes those signals using `run_routes`.

For CLI/browser-originated runs, `run_routes` maps `runId` to the originating WebSocket connection. For adapter-originated runs, it maps `runId` to the adapter, account id, surface kind, surface id, and optional thread id. Routes expire after 30 minutes.

If a run route is missing, the Kernel falls back to broadcasting the signal to connected clients for the owning uid.

## Adapter Routing

Messaging adapters call `adapter.inbound` through a service identity. The Kernel normalizes the adapter id and account id, then resolves the external actor id through `identity_links`.

Inbound behavior:

- Linked actor: resolve the local uid and deliver to a process.
- Unlinked DM actor: return a link challenge such as `gsv auth link CODE`.
- Unlinked non-DM actor: drop the message as `unlinked_actor`.

The default delivery target is the user's `init:{uid}` process. A `surface_routes` entry can override this for a specific adapter account and surface:

```text
adapter + accountId + surface.kind + surface.id -> pid
```

Human-in-the-loop replies are routed specially. If the target process has a pending HIL request, a DM reply of approval or denial resumes `proc.hil` instead of starting a new chat turn.

## Package App Routing

Package UI and RPC calls are routed through package identity frames. The Kernel verifies:

- The package is installed and enabled.
- The route base and entrypoint match the installed manifest.
- The entrypoint grants the requested syscall.
- The user identity in the app frame is still valid.

Package app syscalls can use the same device routing path as clients and processes. Async device responses are held in memory as pending app responses until the device reply or timeout arrives.

## Device Routing

Devices are persistent records in Kernel SQLite. A driver connection registers a device id, owner uid, owner gid, platform, version, and `implements` list. The access model is Linux-like:

- Root can use every device.
- The owner uid can use the device.
- Members of granted groups can use the device.

Device routing does not rename syscalls. Agents and clients always see the same syscall names, such as `fs.read` and `shell.exec`; `target` selects whether the call runs on `gsv` or a device.

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
| `run_routes` | Routes process chat signals back to connections or adapter surfaces. |
| `processes` | Kernel process registry and process ownership. |
| `devices`, `device_access` | Device catalog and group ACLs. |
| `identity_links` | External adapter actor to local uid mapping. |
| `surface_routes` | Adapter surface to process mapping. |
