# WebSocket Protocol Reference

Gateway control requests, responses, and signals use JSON text frames over
`GET /ws`. Requests and successful responses may attach a byte stream carried
by binary frames.

The current protocol is syscall-based:

- requests carry a syscall name in `call`
- responses carry success data in `data`
- signals carry async events in `signal`

The source of truth is:

- `gateway/src/protocol/frames.ts`
- `packages/gsv/src/protocol/request-cancel.ts`
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
| `body` | `BodyDescriptor` | No | Attached request byte stream |

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
| `body` | `BodyDescriptor` | No | Attached byte stream; only valid when `ok` is `true` |

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
    "protocol": 2,
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
| `protocol` | `number` | Yes | Must currently be `2` |
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
    "protocol": 2,
    "server": {
      "version": "0.4.0",
      "release": "dev",
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
    "signals": ["proc.run.output", "proc.run.finished"]
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
| `pkg.*`, `repo.*`, `sys.*`, `sched.*`, `notification.*`, `signal.*` | Kernel-handled |
| `adapter.*` | Service-binding / adapter control path |
| `ai.tools`, `ai.config` | Kernel-internal process bootstrap path |
| Other `ai.*` | Capability-gated inference and media operations |

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
- `proc.run.hil.requested`
- `proc.run.finished`
- `process.exit`
- `device.status`
- `adapter.status`
- `pkg.changed`
- `mcp.changed`
- `notification.created`
- `notification.updated`
- `notification.dismissed`

### Driver connections

- `device.status`

### Service connections

Service connections receive no ambient signals. Adapter workers report state through the gateway service binding.

`proc.run.*` signals are emitted by Process DOs and relayed through run-route tracking. In the current kernel:

- user connections receive routed process signals for their own runs
- adapter surfaces consume HIL and terminal run signals through their run route

### Request cancellation

`request.cancel` is a reserved one-way control signal for cancelling an entire
request:

```json
{
  "type": "sig",
  "signal": "request.cancel",
  "payload": {
    "id": "request-uuid",
    "reason": "User interrupted tool execution"
  }
}
```

The `id` is the original request ID. The optional reason is diagnostic only;
request ownership is determined from the authenticated connection or Process
route. The gateway removes matching routes and body pumps before forwarding the
signal to a driver. Drivers stop the active handler and suppress late responses.
Unknown, duplicate, and post-completion cancellation signals have no effect.

Process abort, reset, kill, user supersession, route expiry, client timeout, and
origin disconnect use this mechanism. Cancellation is best effort for handlers
that have already crossed an irreversible boundary. A `shell.exec` request that
already returned a running session is complete; controlling that session is a
separate operation.

---

## Frame Bodies

A request or successful response announces its body in the JSON frame before
the binary chunks:

```json
{
  "body": {
    "streamId": 42,
    "length": 1048576
  }
}
```

`streamId` is a non-zero unsigned 32-bit integer chosen by the sender.
`length` is optional in the protocol, but operations that require an exact
size may require it. Error responses and signals cannot carry bodies.

Each following binary frame uses this format:


```text
[4 bytes little-endian stream id][1 byte flags][raw chunk bytes]
```

The stream ID links each chunk to its JSON descriptor. Flags identify data,
end, and error frames:

| Flag | Value | Meaning |
|---|---:|---|
| `DATA` | `1` | The payload contains body bytes |
| `END` | `2` | This is the final frame for the stream |
| `ERROR` | `4` | The sender terminated its own stream; the payload contains a UTF-8 error message |
| `CANCEL` | `8` | The receiver no longer wants the sender's stream; the payload may contain a UTF-8 reason |

Flags may be combined; failures normally use `ERROR | END` (`6`). The sender
emits the JSON descriptor first, then zero or more data frames, and finally an
end or error frame. Stream IDs are scoped to the WebSocket connection; a sender
must not reuse an ID until that stream has ended.

Receiver cancellation uses `CANCEL | END` (`10`). The original sender stops its
matching outgoing pump without treating the cancellation as a frame for an
unrelated incoming stream that happens to use the same numeric ID.

Body cancellation stops only the byte pump. Cancelling the whole syscall uses
the `request.cancel` control signal above. The two mechanisms are independent:
a request may have no body, and a completed request may leave a response body
that its consumer can still cancel.

The current body-bearing syscalls are:

| Syscall | Request body | Response body |
|---|---|---|
| `fs.read` | No | Always for a successful file read; raw UTF-8 text or image bytes. Directory listings and operation errors remain JSON-only. |
| `fs.transfer.receive` | Required file bytes | No |
| `fs.transfer.send` | No | Successful file bytes |
| `net.fetch` | Optional HTTP request bytes | HTTP response bytes when the response has a body |
| `proc.media.read` | No | Successful stored media bytes |
| `proc.media.write` | Required media bytes with an exact descriptor length | No |
| `ai.transcription.create` | Required audio bytes | No |
| `ai.image.read` | Required image bytes | No |
| `ai.image.generate` | No | Generated image bytes when returned inline |
| `ai.speech.create` | No | Synthesized audio bytes unless the result is skipped or empty |

The JSON `args` and `data` carry metadata; the top-level body carries bytes.
This avoids syscall-specific stream identifiers and JSON/base64 expansion. In
the JavaScript SDK, use `client.request()` for these calls and consume or cancel
the returned body. `client.call()` and generated namespace methods are
data-only, and body-bearing calls are intentionally omitted from those
namespaces.

## See also

- [Syscalls Reference](./syscalls.md)
- [Routing Reference](./routing.md)
- [CLI Commands](./cli-commands.md)
