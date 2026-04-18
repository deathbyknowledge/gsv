# WebSocket Protocol Reference

All live gateway traffic uses JSON text frames over `GET /ws`.

The current protocol is syscall-based:

- requests carry a syscall name in `call`
- responses carry success data in `data`
- signals carry async events in `signal`

The source of truth is:

- `gateway/src/protocol/frames.ts`
- `shared/protocol/src/syscalls/system.ts`
- `gateway/src/kernel/connect.ts`
- `gateway/src/kernel/dispatch.ts`

---

## Frame Types

### Request Frame

```json
{
  "type": "req",
  "id": "uuid",
  "call": "sys.connect",
  "args": {}
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"req"` | Yes | Request discriminator |
| `id` | `string` | Yes | Request/response correlation ID |
| `call` | `string` | Yes | Syscall name |
| `args` | `object` | No | Syscall arguments |

### Response Frame

Success:

```json
{
  "type": "res",
  "id": "uuid",
  "ok": true,
  "data": {}
}
```

Error:

```json
{
  "type": "res",
  "id": "uuid",
  "ok": false,
  "error": {
    "code": 500,
    "message": "failure"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"res"` | Yes | Response discriminator |
| `id` | `string` | Yes | Matching request ID |
| `ok` | `boolean` | Yes | Success flag |
| `data` | `unknown` | No | Present when `ok` is `true` |
| `error` | `ErrorShape` | No | Present when `ok` is `false` |

### Signal Frame

```json
{
  "type": "sig",
  "signal": "chat.complete",
  "payload": {},
  "seq": 1
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"sig"` | Yes | Signal discriminator |
| `signal` | `string` | Yes | Signal/event name |
| `payload` | `unknown` | No | Signal payload |
| `seq` | `number` | No | Optional sequence number |

### ErrorShape

```json
{
  "code": 401,
  "message": "Authentication required",
  "details": {},
  "retryable": false
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `number` | Yes | Error code |
| `message` | `string` | Yes | Human-readable message |
| `details` | `unknown` | No | Structured error context |
| `retryable` | `boolean` | No | Retry hint |

---

## Connection Lifecycle

1. Open a websocket to `GET /ws`.
2. Send `sys.connect` as the first request.
3. Wait for a normal success response or a structured error.
4. After connect succeeds, exchange syscall requests, responses, and signals until the socket closes.

The gateway rejects setup-mode connections with error code `425` and details:

```json
{
  "setupMode": true,
  "next": "sys.setup"
}
```

---

## `sys.connect`

`sys.connect` is the handshake syscall. It authenticates the caller, assigns identity, registers drivers or services, and returns the allowed syscall/signal surface.

### Request

```json
{
  "type": "req",
  "id": "uuid",
  "call": "sys.connect",
  "args": {
    "protocol": 1,
    "client": {
      "id": "client-123",
      "version": "0.1.0",
      "platform": "linux",
      "role": "user"
    },
    "auth": {
      "username": "alice",
      "password": "secret"
    }
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `protocol` | `number` | Yes | Must currently be `1` |
| `client.id` | `string` | Yes | Client identifier |
| `client.version` | `string` | Yes | Client version |
| `client.platform` | `string` | Yes | Platform string |
| `client.role` | `"user" \| "driver" \| "service"` | Yes | Connection role |
| `client.channel` | `string` | No | Required for `service` role |
| `driver.implements` | `string[]` | No | Required for `driver` role |
| `auth.username` | `string` | No | Required when authenticating |
| `auth.password` | `string` | No | User-password auth |
| `auth.token` | `string` | No | Token auth. Required for machine connections. |

### Response

```json
{
  "type": "res",
  "id": "uuid",
  "ok": true,
  "data": {
    "protocol": 1,
    "server": {
      "version": "dev",
      "connectionId": "conn-123"
    },
    "identity": {
      "role": "user",
      "process": {
        "uid": 1000,
        "gid": 1000,
        "gids": [1000],
        "username": "alice",
        "home": "/home/alice",
        "cwd": "/home/alice",
        "workspaceId": null
      },
      "capabilities": ["fs.*", "proc.*"]
    },
    "syscalls": ["fs.read", "proc.send"],
    "signals": ["chat.text", "chat.complete"]
  }
}
```

**Role-specific identity payloads**

| Role | Extra fields |
|---|---|
| `user` | none |
| `driver` | `device`, `implements` |
| `service` | `channel` |

---

## Request Routing

The websocket protocol itself is uniform, but syscall handling depends on the domain:

| Domain | Behavior |
|---|---|
| `fs.*` | Native on `gsv`, or routed to a driver when `args.target` names a device |
| `shell.exec` | Native on `gsv`, or routed to a driver when `args.target` names a device |
| `proc.*` | Kernel and Process DO control plane |
| `pkg.*`, `knowledge.*`, `sys.*`, `notification.*`, `signal.*` | Kernel-handled |
| `adapter.*` | Service-binding / adapter control path |
| `ai.*` | Kernel-internal process bootstrap path |
| `sched.*` | Defined but currently return `501 not yet implemented` |

For routed `fs.*` and `shell.exec` requests, the gateway strips `args.target` before forwarding the request frame to the driver.

Current compatibility caveat:

- the CLI driver bridge is still legacy in a few spots, notably `fs.search` (`query` vs local `pattern`)

---

## Current Syscall Surface

The dispatcher in `gateway/src/kernel/dispatch.ts` currently handles these names:

### Filesystem

- `fs.read`
- `fs.write`
- `fs.edit`
- `fs.delete`
- `fs.search`

### Shell

- `shell.exec`

### Processes

- `proc.list`
- `proc.profile.list`
- `proc.spawn`
- `proc.send`
- `proc.abort`
- `proc.hil`
- `proc.kill`
- `proc.history`
- `proc.reset`
- `proc.setidentity`

### Packages

- `pkg.list`
- `pkg.add`
- `pkg.sync`
- `pkg.checkout`
- `pkg.install`
- `pkg.review.approve`
- `pkg.remove`
- `pkg.repo.refs`
- `pkg.repo.read`
- `pkg.repo.log`
- `pkg.repo.search`
- `pkg.repo.diff`
- `pkg.remote.list`
- `pkg.remote.add`
- `pkg.remote.remove`
- `pkg.public.list`
- `pkg.public.set`

### AI Bootstrap

- `ai.tools`
- `ai.config`

### System

- `sys.connect`
- `sys.setup.assist`
- `sys.setup`
- `sys.bootstrap`
- `sys.config.get`
- `sys.config.set`
- `sys.device.list`
- `sys.device.get`
- `sys.workspace.list`
- `sys.token.create`
- `sys.token.list`
- `sys.token.revoke`
- `sys.link`
- `sys.unlink`
- `sys.link.list`
- `sys.link.consume`

### Scheduler

- `sched.list`
- `sched.add`
- `sched.update`
- `sched.remove`
- `sched.run`

### Adapters

- `adapter.connect`
- `adapter.disconnect`
- `adapter.inbound`
- `adapter.state.update`
- `adapter.send`
- `adapter.status`

### Knowledge

- `knowledge.list`
- `knowledge.db.list`
- `knowledge.db.init`
- `knowledge.db.delete`
- `knowledge.read`
- `knowledge.write`
- `knowledge.search`
- `knowledge.merge`
- `knowledge.promote`
- `knowledge.query`
- `knowledge.ingest`
- `knowledge.compile`

### Notifications and Signal Watches

- `notification.create`
- `notification.list`
- `notification.mark_read`
- `notification.dismiss`
- `signal.watch`
- `signal.unwatch`

---

## Signals

The connect response advertises the signal set allowed for the role.

Current role defaults from `buildSignalList()`:

### User connections

- `chat.text`
- `chat.tool_call`
- `chat.tool_result`
- `chat.hil`
- `chat.complete`
- `process.exit`
- `device.status`
- `adapter.status`
- `pkg.changed`

### Driver connections

- `device.status`

### Service connections

- `adapter.status`

`chat.*` signals are emitted by Process DOs and relayed through run-route tracking. In the current kernel:

- user connections receive routed `chat.*` signals for their own runs
- adapter surfaces only use `chat.hil` and `chat.complete`

---

## Binary Frames

Binary-frame helpers still exist in the CLI protocol module, using this format:

```text
[4 bytes little-endian transfer id][raw chunk bytes]
```

That code is marked legacy/future-use in `cli/src/protocol.rs`. The current gateway syscall surface in this repo does not expose a public transfer syscall, so ordinary runtime traffic is JSON text frames only.
