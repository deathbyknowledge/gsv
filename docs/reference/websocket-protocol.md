# WebSocket Protocol Reference

Gateway control requests, responses, and signals use JSON text frames over
`GET /ws`. Requests and successful responses may attach a byte stream carried
by binary frames.

Protocol version 3 is peer- and syscall-based:

- requests carry a syscall name in `call`
- responses carry success data in `data`
- signals carry async events in `signal`

The source of truth is:

- `packages/gsv/src/protocol/wire-frame.ts`
- `gateway/src/protocol/frames.ts`
- `gateway/src/protocol/decode-wire-frame.ts`
- `tools/protocol/generate-gateway-wire-validator.mjs`
- `packages/gsv/src/protocol/request-cancel.ts`
- `packages/gsv/src/protocol/adapters.ts`
- `packages/gsv/src/protocol/adapter-media-body.ts`
- `packages/gsv/src/protocol/syscalls/proc.ts`
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
| `args` | `object` | Yes | Arguments for the exact syscall named by `call` |
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
| `data` | JSON value | No | Present when `ok` is `true`; must match the routed syscall result |
| `error` | `ErrorShape` | No | Present when `ok` is `false` |
| `body` | `BodyDescriptor` | No | Attached byte stream; only valid when `ok` is `true` |

### Signal Frame

```json
{
  "type": "sig",
  "signal": "proc.run.finished",
  "payload": {
    "pid": "proc-id",
    "runId": "run-id",
    "status": "ok",
    "result": { "text": "completed work" },
    "delivery": { "kind": "none" },
    "queuedCount": 0,
    "timestamp": 1710000000000
  },
  "seq": 1
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"sig"` | Yes | Signal discriminator |
| `signal` | `string` | Yes | Signal/event name |
| `payload` | JSON value | No | Signal payload |
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
| `details` | JSON value | No | Structured error context |
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

Managed first boot is different: a provisioning hostname may serve the desktop
and accept its WebSocket, but normal `sys.connect` returns `503` until setup is
complete. `sys.setup` and `sys.setup.assist` must include the one-time
`onboardingToken` issued for that exact installation. The Kernel removes the
token before invoking the ordinary setup implementation and activates routing
only after setup succeeds.

---

## `sys.connect`

`sys.connect` is the handshake syscall. It authenticates the principal, binds a
live peer session, and returns the Kernel-authoritative call, signal, and
implementation grants. The request does not contain a role. Principal kind is
derived from the password or token used to authenticate.

### Request

```json
{
  "type": "req",
  "id": "uuid",
  "call": "sys.connect",
  "args": {
    "protocol": 3,
    "peer": {
      "id": "desktop-alice",
      "version": "0.1.0",
      "platform": "linux",
      "implements": ["fs.*", "shell.exec"]
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
| `protocol` | `number` | Yes | Must currently be `3` |
| `peer.id` | `string` | Yes | Stable application, machine, or service identity |
| `peer.version` | `string` | Yes | Peer version |
| `peer.platform` | `string` | Yes | Platform string |
| `peer.implements` | `string[]` | No | Requested reverse syscall implementation patterns. Machine credentials require at least one. |
| `auth.username` | `string` | No | Required when authenticating |
| `auth.password` | `string` | No | User-password auth |
| `auth.token` | `string` | No | User, node, or service token auth |

Password and token are mutually exclusive. A node token is bound to the exact
`peer.id` recorded when the token was created. `peer.implements` is an
advertisement, not authority: the Kernel validates it and independently derives
the returned grants.

### Response

```json
{
  "type": "res",
  "id": "uuid",
  "ok": true,
  "data": {
    "protocol": 3,
    "server": {
      "version": "0.4.0",
      "release": "dev",
      "features": ["ai.provider.gsv"],
      "connectionId": "conn-123"
    },
    "peer": {
      "id": "desktop-alice",
      "sessionId": "conn-123",
      "principal": {
        "kind": "human",
        "account": {
          "uid": 1000,
          "gid": 1000,
          "gids": [1000, 100],
          "username": "alice",
          "home": "/home/alice",
          "cwd": "/home/alice"
        }
      },
      "grant": {
        "calls": ["fs.*", "proc.*"],
        "signals": ["proc.changed", "message.committed", "peer.pong"],
        "implements": ["fs.*", "shell.exec"]
      }
    }
  }
}
```

`server.features` is an optional list of runtime capabilities advertised by the
connected deployment. Managed gateways with the private GSV inference binding
include `ai.provider.gsv`; standalone gateways omit it.

The three grant axes are independent:

- `calls` lists syscall patterns the peer may invoke;
- `signals` lists asynchronous signals it may receive; and
- `implements` lists syscall patterns GSV may route back to this peer.

`peer.id` is stable across reconnects. `peer.sessionId` identifies this live
socket incarnation. Neither is a credential.

---

## Syscall Dispatch

The Kernel decodes each incoming text frame once at the WebSocket boundary.
Requests are validated against the argument contract for their exact `call`.
Successful endpoint responses are validated against the result contract recorded
on the matching route. Dispatch and syscall handlers therefore receive trusted
protocol types and do not repeat structural type checks. Authorization,
resource limits, and other semantic policy remain the responsibility of the
owning Kernel or syscall handler.

The websocket protocol is uniform: every operation is a `req` frame with a syscall name in `call`. Dispatch behavior depends on the syscall domain:

| Domain | Behavior |
|---|---|
| `fs.*` | Native on `gsv`, or routed to an endpoint when `args.target` names a registered target |
| `shell.exec` | Native on `gsv`, routed to an endpoint when `args.target` names a registered target, or routed by `args.sessionId` for an existing shell session |
| `proc.*` | Kernel and Process DO control plane |
| `conversation.*` | Kernel-owned canonical conversation state and media |
| `contact.*` | Kernel-owned contact pairing, authenticated cross-GSV delivery, requests, and revocation |
| `repo.*`, `sys.*`, `sched.*`, `signal.*` | Kernel-handled |
| `adapter.*` | Service-binding / adapter control path |
| `ai.tools`, `ai.config` | Kernel-internal process bootstrap path |
| Other `ai.*` | Capability-gated inference and media operations |

For routed `fs.*` and initial `shell.exec` requests, the gateway strips
`args.target` before forwarding the request frame to the endpoint. Shell
continuations use `args.sessionId`; the gateway looks up the session owner and
forwards the same `shell.exec` frame to that endpoint.

Use the [Syscalls Reference](/reference/syscalls) for the full syscall surface.

---

## Signals

The connect response advertises the signal set granted to that peer.

Current principal defaults from `buildSignalList()`:

### Human peers

- `proc.changed`
- `proc.run.started`
- `proc.run.stream`
- `proc.run.retrying`
  - Carries `attempt`, `nextAttempt`, `maxAttempts`, and a sanitized `reason`.
    A retry after context compaction stays on the active model and has no
    `fallback` field; model fallback transitions include their source and target.
- `proc.run.output`
  - Carries raw assembled assistant text, model reasoning, and process-owned
    media references for process inspection. It is not a user-facing Message
    and does not imply delivery to an endpoint.
- `proc.run.tool.started`
  - Emitted after a tool execution is durably marked dispatched. Its payload
    includes `pid`, `runId`, provider `callId`, and the unique `executionId`
    used for that dispatch, alongside the existing tool name, syscall, and
    arguments.
- `proc.run.tool.finished`
  - Emitted when each started execution first reaches a terminal outcome.
    Consumers deduplicate by `executionId`. The payload is `{ pid, runId,
    executionId, callId, outcome, timestamp }`, where `outcome` is `completed`,
    `failed`, `cancelled`, or `denied`. It carries no tool arguments, output, or
    error content. Delivery is best effort, like other Process signals.
- `proc.run.hil.requested`
  - Web, Desktop, and CLI receive this structured signal. An exact routed
    adapter receives the same request inside targeted `adapter.send`. Clients
    answer with `proc.hil` and the exact `requestId`; adapters may render native
    controls or direct the user to Chat without exposing the opaque request
    identity. A native adapter callback submits
    ordinary `proc.hil` through a Kernel-derived linked-human peer. Stale links,
    route generations, destinations, provider-message correlations, and pending
    requests fail closed; provider reply threading is not authorization.
    The payload includes the Process-resolved `target` so clients can explain
    the approval scope without reproducing routing policy from raw arguments.
- `proc.run.finished`
  - Reports the terminal Process-run status. A successful user-facing response
    is represented separately by `message.committed`.
- `process.exit`
- `conversation.changed`
  - Announces that canonical conversation history has advanced. Clients use
    `conversation.history` to synchronize the durable record.
- `message.started`
  - Begins the directed endpoint's transient projection of a Process Message.
- `message.delta`
  - Appends text to that transient projection. It is sent only to the connection
    that admitted the run; other clients synchronize the committed Message.
- `message.committed`
  - Carries a canonical `ConversationMessage`. `directed` is true only for the
    connection whose input admitted the run; other connected clients receive
    the same committed Message with `directed: false`.
- `message.aborted`
  - Discards the directed endpoint's transient projection when a Message cannot
    be committed or the run is superseded.
- `device.status`
- `adapter.status`
- `mcp.changed`
- `peer.pong`

### Machine peers

- `device.status`
- `peer.pong`

### Service peers

Service peers receive no ambient WebSocket signals. Adapter workers report
state through the Gateway service binding and receive only targeted
`adapter.send` requests through `adapterFrame`. The surrounding Kernel-owned
delivery context identifies the exact destination and carries structured HIL
when present.

An endpoint may send `peer.ping` with an optional payload and sequence. The
Kernel echoes them in `peer.pong` while that endpoint is the active session for
its registered target. This is a generic endpoint heartbeat, not a machine-only
protocol.

`proc.run.*` signals are raw Process activity emitted by Process DOs. In the
current Kernel:

- the connection that admitted a run receives its activity through the exact
  run route
- another user connection receives that activity only after explicitly calling
  `proc.observe` for the owner-scoped Process; `proc.unobserve` removes the watch
- idle owner connections receive only a content-free `proc.changed` invalidation
  for process-list synchronization, not its raw message, context, or run fields
- `proc.run.hil.requested` is broadcast to every connected user client for the
  process owner; its payload includes `pid`, and `proc.history` recovers pending
  requests after reconnects
- adapter routes turn an exact `proc.run.hil.requested` or directed committed
  Message into a targeted `adapter.send`; adapters do not parse prompt text or
  render raw model output as a reply

Canonical `conversation.*` and `message.*` signals are independent of raw
Process observation. All connected clients for the owner can synchronize the
same conversation, while only the directed connection receives transient
Message streaming. `message send` commits without finishing the run; the model must explicitly
finish a human-facing run through Shell with `yield`. A final send composes as
`message send ... && yield`; ordinary assistant output remains Process activity. For a
bounded IPC worker, ordinary final output becomes `proc.run.finished.payload.result` and
`delivery.kind` remains `"none"`.

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
signal to an endpoint. Endpoints stop the active handler and suppress late
responses.
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

A WebSocket may expose several already-buffered data frames without an I/O
wait between them. Receiver pumps must give the registered body owner a chance
to drain its bounded queue between those frames; transport scheduling alone
must not turn a valid body into a buffer-overflow failure. That cooperation
must not suspend the connection-wide reader on one body consumer: cancellation,
unrelated frames, and peer closure must remain readable.

The current body-bearing syscalls are:

| Syscall | Request body | Response body |
|---|---|---|
| `fs.read` | No | Raw UTF-8 text, or image bytes when `representation` is `content`. Resource-mode image reads, directory listings, and operation errors are JSON-only. |
| `fs.transfer.receive` | Required file bytes | No |
| `fs.transfer.send` | No | Successful file bytes |
| `net.fetch` | Optional HTTP request bytes | HTTP response bytes when the response has a body |
| `conversation.media.read` | No | Successful legacy conversation media bytes |
| `ai.transcription.create` | Required audio bytes | No |
| `ai.image.read` | Required image bytes | Decoded UTF-8 text when caption, query, or OCR requests set `stream: true` |
| `ai.image.generate` | No | Generated image bytes when returned inline |
| `ai.speech.create` | No | Synthesized audio bytes unless the result is skipped or empty |
| `adapter.inbound` | Optional concatenated media bytes referenced by metadata ranges | No |
| `adapter.send` | Optional concatenated media bytes referenced by metadata ranges | No |

The JSON `args` and `data` carry metadata; the top-level body carries bytes.
This avoids syscall-specific stream identifiers and JSON/base64 expansion. In
the JavaScript SDK, use `client.request()` for these calls and consume or cancel
the returned body. `client.call()` and generated namespace methods are
data-only, and body-bearing calls are intentionally omitted from those
namespaces.

Adapter requests may describe several media items inside that one body. Each
body-backed `AdapterMedia` item carries `body: { offset, length }`. Ranges
start at zero, are contiguous in media-array order, use safe non-negative
integers, and must describe the complete body. An item may use a body range or a
URL, never both. The Gateway currently caps adapter media at 20 items, 48 MiB
per body-backed item, and 48 MiB total.

The adapter media consumer keeps sole ownership of the top-level reader and
provides one bounded part stream at a time. The callback must consume that part
before returning. Success consumes the body through its exact end; validation
failure, cancellation, or a downstream error cancels the stream and prevents
later parts from being processed. Adapter service bindings use the same
metadata/body ownership contract even though they do not encode the stream as
WebSocket binary chunks between workers. Cross-Worker and cross-Durable-Object
RPC forwards the body as a byte-oriented `ReadableStream`, preserving
backpressure and cancellation rather than materializing or serializing it.

Adapter retry identity remains in JSON, not in the binary framing layer.
Inbound events must reuse their provider `message.messageId`. The Kernel claims
the normalized adapter/account/actor/surface/thread/message tuple before any
side effect; completed replays return the persisted disposition, while a live
concurrent replay returns `in_progress` and its body is cancelled. Persistent
adapter account Durable Objects retain the compact provider payload before the
first RPC and retry transport failures or `in_progress` with their existing
alarm until a terminal disposition. Immediate inbound
replies carry a deterministic delivery id and therefore enter the same adapter
delivery ledger as every other outbound message. Outbound
`adapter.send` calls that are retried must reuse `deliveryId`; the successful
result echoes it and reports `deliveryState` as `sent`, `deduplicated`, or
`ambiguous`. A retryable failure means only that replaying the same delivery id
with the same destination and content is safe. Adapter account ledgers bind the
id to a request fingerprint and reject a replay whose destination, reply
context, text, media metadata, or binary media bytes differ. A new id always
denotes a new logical message.

## See also

- [Syscalls Reference](./syscalls.md)
- [Routing Reference](./routing.md)
- [CLI Commands](./cli-commands.md)
