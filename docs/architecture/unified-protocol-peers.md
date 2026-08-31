# Unified Protocol Peers

Status: **implemented in protocol version 3**.

GSV has one request, response, signal, body, and cancellation model. A browser,
native application, CLI, machine daemon, or adapter service is a protocol peer.
WebSocket and Workers RPC are carriers for that model rather than different
application protocols.

## Why the model exists

The old connection roles coupled unrelated decisions. A `user` could call
syscalls but could not implement one; a `driver` could implement syscalls but
was not treated like a full client; an adapter used a restricted parallel RPC
path even when a command such as `/list` was an ordinary user operation.

Protocol peers separate the independent questions:

- who is acting;
- which live program or service is connected;
- what it may call;
- which signals it may receive;
- what it can implement for GSV; and
- how frames and bodies reach it.

That separation lets a native application be both an interactive client and a
filesystem or audio endpoint. It lets a linked Telegram actor invoke a bounded
ordinary syscall without giving the Telegram Worker login authority. It also
keeps Process observation separate from user-facing Messages.

## Public peer contract

`sys.connect` returns the Kernel-authoritative peer:

```ts
type ConnectedPeer = {
  id: string;
  sessionId: string;
  principal: {
    kind: "human" | "machine" | "service";
    account: ProcessIdentity;
  };
  grant: {
    calls: string[];
    signals: string[];
    implements: string[];
  };
};
```

These fields are deliberately different axes.

### Principal

`principal` answers **who is acting**. Its kind is derived from the credential,
never claimed in the connect request.

- Password and user-token authentication produce a human principal.
- A node token produces a machine principal and is bound to its machine id.
- A service token or a fixed first-party service binding produces a service
  principal.
- Linked adapter ingress produces a short-lived delegated human context only
  after the Kernel resolves its owned identity link.

The account carries the uid, gids, home, and working directory used for
authorization and syscall execution.

### Peer and session identity

`peer.id` answers **which program, machine, or service is participating**.
Routeable endpoints keep it stable across reconnects; an ephemeral client may
use an incarnation-specific id. Examples are a desktop installation id, a
machine id, or `telegram`.

`sessionId` answers **which live incarnation is carrying frames now**. It is
Kernel-assigned and changes on reconnect. Exact routes use the live session;
durable ownership and machine records use stable identities.

Neither identifier is a credential.

### Peers and targets

A peer is not inherently a target. The peer describes the live protocol
participant; a target is the Unix-shaped capability environment that participant
offers for routed work. A peer may offer no target, one target, or multiple
targets, and the native `gsv` target has no external peer at all.

Principal kind also does not define target-ness. A machine principal commonly
backs a hardware target, a human browser endpoint can back a browser-profile
target, and a service peer can back an external-service target. In every case,
the Kernel separately authorizes the caller, resolves the target, intersects
the effective `implements` grant, and routes the unchanged syscall.

See [Targets and Capability Environments](./targets.md) for the coherence
contract and adapter-backed target model.

### Grant axes

The three grant lists are independent:

- `calls`: syscall patterns the peer may send to GSV;
- `signals`: asynchronous signal names GSV may send to the peer;
- `implements`: syscall patterns GSV may route to the peer.

The connect request may advertise `peer.implements`, but the Kernel validates
the patterns and returns the effective grant. Advertising an implementation
does not add call authority. Credentials and Kernel policy determine `calls`
and `signals`.

Common combinations are:

| Participant | Principal | Calls | Signals | Implements |
|---|---|---|---|---|
| Web UI | human | human capabilities | user signals | none |
| CLI | human | human capabilities | user signals | none |
| Desktop app | human | human capabilities | user signals | optional host operations |
| Machine daemon | machine | minimal control calls | machine signals | filesystem, shell, network, and host operations |
| Adapter Worker | service | adapter ingress and delivery coordination | routed `message.committed`, `proc.run.hil.requested` | none |
| Linked adapter command | delegated human | command-specific intersection | none | none |

A human endpoint with implementations remains a human peer. It is not promoted
to a machine and does not lose its client facilities.

## Internal peer context

After authentication the Kernel adds transport and provenance to the public
peer:

```text
PeerContext
  installationId  immutable outer tenant boundary
  peer             public principal and grants
  transport        websocket | service-binding | process-rpc | kernel
  provenance       credential | service-binding | adapter-link | process | kernel
```

Transport does not grant authority. Provenance records how authority was
obtained so policy can distinguish a password-authenticated human from an
adapter-linked human even when both resolve to the same uid.

## One frame protocol

Every carrier transports the same logical frames:

```text
req { id, call, args, body? }
res { id, ok, data|error, body? }
sig { signal, payload?, seq? }
```

The Kernel validates an external frame once, constructs a `PeerContext`, and
enters one dispatcher. Capability checks, target routing, request cancellation,
post-dispatch effects, and body ownership are shared.

### WebSocket byte flow

```text
client JSON req
  -> Gateway WebSocket boundary validates it
  -> Kernel dispatches locally or routes the same req to an endpoint
  -> endpoint JSON res returns on the same socket
  -> Kernel forwards the correlated res to the origin
```

If a request or response has bytes, its JSON frame carries a body descriptor.
Binary WebSocket chunks carry the stream id, flags, and bytes. Backpressure and
cancellation remain streaming end to end.

### Workers RPC byte flow

```text
adapter normalized req + optional BinaryBody
  -> AdapterGatewayEntrypoint validates deployment-owned binding props
  -> Kernel validates and dispatches the same logical req
  -> correlated res returns through the binding

Kernel routed sig + optional BinaryBody
  -> adapterFrame selects the deployment-owned adapter binding
  -> adapter account or peer DO durably accepts the frame and body
  -> null acknowledges signal ownership; provider delivery continues durably
```

Workers RPC carries `BinaryBody.stream` as a `ReadableStream`; it is not
base64-encoded or buffered into the frame. The service binding is part of the
trust boundary: its `props` carry the adapter id and attenuated call grant, and
Cloudflare supplies those props from deployment configuration rather than the
adapter's request. Every first-party adapter uses the same entrypoint; adding
one does not add another Gateway class. The generic Gateway entrypoint retains
a narrow rolling-upgrade bridge for already-deployed adapters: it accepts only
known adapter ids and the same two attenuated calls, deriving identity from the
validated request. New bindings use only `AdapterGatewayEntrypoint`. During a
rolling release, deploy the Gateway before adapters switch their bindings.

Outbound adapter selection is the inverse mapping. The Kernel normalizes the
adapter id to a deployment binding key such as `CHANNEL_TELEGRAM` and reads that
binding dynamically from its environment. The peer never supplies a binding
key, and no central source registry has to change when deployment adds another
adapter.

Gateway-to-adapter delivery uses the same logical frame shapes. Explicit
`adapter.send` is a correlated `req`/`res`; Process-directed delivery is an
exact `message.committed` or `proc.run.hil.requested` signal. The surrounding
delivery context carries the Kernel-owned route projection, not a second
semantic operation. Provider credentials, formatting, durable acceptance,
retry ledgers, ambiguous-outcome policy, and rendering remain adapter-owned.
The older typed `adapterSend` method is a rolling-upgrade bridge, not the
canonical path.

## Reverse calls and endpoints

A peer that advertises implementations can receive `req` frames from GSV and
return ordinary `res` frames. The public SDK exposes this as
`client.endpoint()`:

```ts
const endpoint = client.endpoint({
  peerId: "my-laptop",
  implements: ["fs.*", "shell.exec"],
});

endpoint.implement("fs.read", async (request, context) => {
  // Return metadata plus an optional streaming body.
});
```

The same route table correlates responses from human endpoints and machine
daemons. `request.cancel` cancels the operation; body cancel frames independently
stop an unwanted byte stream. Disconnects, timeouts, malformed responses, and
late responses remove routes and release owned bodies.

`peer.ping` and `peer.pong` are generic endpoint liveness signals. They replace
the old device-specific heartbeat names.

The Kernel currently retains `device` names in its persisted target registry
and machine-management syscalls for upgrade compatibility. That storage detail
does not define the public target model: any authorized peer with coherent
implementations may back a route target.

## Adapters and delegated humans

An adapter has two authorities that must not be conflated.

1. The Worker is a service peer. It authenticates provider traffic, owns
   provider state, normalizes actor and surface ids, and calls only its fixed
   adapter operations.
2. A linked external actor may create an interaction-scoped delegated human
   peer. The Kernel derives the local uid and grants; the adapter supplies
   neither.

```text
provider event
  -> fixed adapter service peer
  -> Kernel resolves actor link and surface
  -> delegated human peer with an attenuated grant
  -> ordinary dispatcher
```

`/list` demonstrates this path. It invokes the real `proc.list` syscall with a
grant containing only `proc.list`, then applies bounded text formatting.
`/help`, `/where`, and `/ship` share Kernel-owned parsing and help metadata.
`/ship` intentionally remains a Kernel routing operation because it must clear
the exact adapter route and preserve durable ingress/recovery fences.

Native approval buttons use the same delegation rule. The adapter durably binds
an opaque callback to the exact HIL request and provider message. On a click it
submits an ordinary `proc.hil` request through `linkedPeerFrame`; the Kernel
derives the linked human, intersects that user's capabilities with `proc.hil`,
rechecks the route generation and destination, and enters the ordinary
dispatcher. The adapter service principal itself is never granted `proc.hil`.

Managed adapter pairing remains an explicit human action through
`adapter.pair.*`. Pairing binds an external actor to an installation and local
uid; it is not transport authentication and cannot be inferred from a Telegram
username, peer id, or service binding.

## Interaction, Messages, and observation

The protocol does not add flags such as `interactionInput` or
`processObservation` because these are already explicit operations:

- `conversation.send` or `proc.send` admits input;
- `proc.observe` and `proc.unobserve` control raw Process observation;
- `message.*` signals project user-facing output;
- `proc.run.*` signals project raw Process activity.

A client may inspect reasoning, tool calls, and output from several Processes
without treating all of it as a message addressed to the user. A committed
Message synchronizes through canonical Conversation history. Only the endpoint
whose input admitted the run receives its transient directed Message stream.
Adapters own provider delivery of directed committed Messages and approval
requests, choose native or fallback presentation, and do not render raw Process
output as replies.

## Security and lifecycle invariants

- Installation identity is resolved before a managed Kernel is addressed.
- Principal kind comes from credentials or a fixed binding, never a request
  role field.
- The Kernel derives delegated uid, groups, calls, and provenance.
- Requested implementations do not widen call or signal grants.
- Adapter binding props cannot be overridden by a frame to impersonate another adapter.
- External frames are validated at the carrier boundary; internal code uses the
  trusted protocol types.
- Every body has one owner and one terminal outcome: consumed, forwarded, or
  cancelled.
- Request cancellation and body cancellation propagate across routes.
- Provider replay, delivery idempotency, route generations, relinking, and
  platform formatting remain adapter-owned.
- Process observation never grants process control or user-message delivery.

## Deliberate non-goals

This model does not create a notification subsystem, make every Process signal
a user message, grant linked messaging identities full password-login authority,
move provider SDKs into the Kernel, or require WebSockets and third-party
providers to have identical durability.

It also does not require Cap'n Web. GSV already needs protocol-specific syscall
contracts, streamed bodies, explicit signals, and hibernation-safe routing. A
future carrier may use another RPC representation without changing the peer
model described here.

## Source map

- Public types and JavaScript endpoint: `packages/gsv/src/protocol/` and
  `packages/gsv/src/client.ts`
- Peer authentication and grants: `gateway/src/kernel/connect.ts`
- Peer context and delegation: `gateway/src/kernel/peer.ts`
- Shared dispatcher and routing: `gateway/src/kernel/do.ts` and
  `gateway/src/kernel/dispatch.ts`
- Adapter command frontend: `gateway/src/kernel/adapter-commands.ts`
- Service peer entrypoints: `gateway/src/index.ts`
- Rust carrier and endpoint support: `host/crates/gateway-client/`
- Frame and body reference: `docs/reference/websocket-protocol.md`
