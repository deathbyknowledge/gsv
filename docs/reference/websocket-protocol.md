# WebSocket Protocol Reference

All live gateway traffic uses JSON text frames over `GET /ws`.

The current protocol is syscall-based:

- requests carry a syscall name in `call`
- responses carry success data in `data`
- signals carry async events in `signal`

The source of truth is:

- `gateway/src/protocol/frames.ts`
- `packages/gsv/src/protocol/syscalls/system.ts`
- `gateway/src/kernel/connect.ts`
- `gateway/src/kernel/dispatch.ts`

For syscall arguments, result shapes, and domain behavior, see [Syscalls Reference](/reference/syscalls).

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
  "signal": "proc.run.finished",
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
        "cwd": "/home/alice"
      },
      "capabilities": ["fs.*", "proc.*"]
    },
    "syscalls": ["fs.read", "proc.send"],
    "signals": ["proc.run.stream", "proc.run.output", "proc.run.finished"]
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

## Syscall Dispatch

The websocket protocol is uniform: every operation is a `req` frame with a syscall name in `call`. Dispatch behavior depends on the syscall domain:

| Domain | Behavior |
|---|---|
| `fs.*` | Native on `gsv`, or routed to a driver when `args.target` names a device |
| `shell.exec` | Native on `gsv`, routed to a driver when `args.target` names a device, or routed by `args.sessionId` for an existing shell session |
| `proc.*` | Kernel and Process DO control plane |
| `pkg.*`, `repo.*`, `sys.*`, `sched.*`, `notification.*`, `signal.*`, `ai.transcription.create`, `ai.speech.create` | Kernel-handled |
| `adapter.*` | Service-binding / adapter control path |
| `ai.tools`, `ai.config` | Kernel-internal process bootstrap path |

For routed `fs.*` and initial `shell.exec` requests, the gateway strips `args.target` before forwarding the request frame to the driver. Shell continuations use `args.sessionId`; the gateway looks up the session owner and forwards the same `shell.exec` frame to that device.

Use the [Syscalls Reference](/reference/syscalls) for the full syscall surface.

---

## Signals

The connect response advertises the signal set allowed for the role.

Current role defaults from `buildSignalList()`:

### User connections

- `proc.changed`
- `proc.run.started`
- `proc.run.stream`
- `proc.run.retrying`
- `proc.run.output`
- `proc.run.tool.started`
- `proc.run.tool.finished`
- `proc.run.hil.requested`
- `proc.run.finished`
- `process.exit`
- `device.status`
- `adapter.status`
- `pkg.changed`

### Driver connections

- `device.status`

### Service connections

- `adapter.status`

`proc.run.*` signals are emitted by Process DOs and relayed through run-route tracking. In the current kernel:

- user connections receive routed `proc.run.*` signals for their own runs
- adapter surfaces use `proc.run.hil.requested` and `proc.run.finished`
- durable watches can subscribe to `proc.changed` for message, context, queue, and conversation lifecycle changes

`proc.run.stream` carries the provider stream event exactly in the pi-ai
assistant event shape:

```json
{
  "pid": "proc-123",
  "runId": "run-123",
  "conversationId": "default",
  "seq": 3,
  "event": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "hello",
    "partial": {}
  },
  "timestamp": 1760000000000
}
```

The nested `event.type` values are `start`, `text_start`, `text_delta`,
`text_end`, `thinking_start`, `thinking_delta`, `thinking_end`,
`toolcall_start`, `toolcall_delta`, `toolcall_end`, `done`, and `error`.
Consumers should use `contentIndex` for block identity; different block streams
are not guaranteed to be contiguous.

`proc.run.retrying` is emitted after a retryable generation failure and before
the next model attempt. Its payload includes `runId`, `conversationId`,
`attempt`, `nextAttempt`, `maxAttempts`, `reason`, and `timestamp`.

---

## Binary Frames

Binary-frame helpers still exist in the CLI protocol module, using this format:

```text
[4 bytes little-endian transfer id][raw chunk bytes]
```

That code is marked legacy/future-use in `cli/src/protocol.rs`. The current gateway syscall surface in this repo does not expose a public transfer syscall, so ordinary runtime traffic is JSON text frames only.
