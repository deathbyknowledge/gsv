# Unified Protocol Peers (Proposal)

Status: **design only and deferred**. Finish the managed staging dogfood and
stabilize the native application before implementing this proposal. No wire
contract, migration, syscall, or compatibility behavior described here exists
yet.

## Problem

GSV currently separates clients and adapters more deeply than their actual
roles require.

- Web, native, and CLI clients connect over WebSocket, call ordinary syscalls,
  and receive broad process signals.
- Adapter Workers communicate over service bindings. They use the same frame
  shape, but enter through a restricted `serviceFrame` path and mostly call
  adapter-specific syscalls.
- Text commands exposed by an adapter can reproduce client operations such as
  listing processes, but do so through a separate command path.
- An adapter receives the exact final answer routed back to its originating
  conversation. A client receives owner-wide `proc.run.*` signals and must
  infer which output was actually addressed to its interaction.

This makes adapters artificially narrow and clients artificially unaware of
routing. It also encourages provider-specific command implementations and
client heuristics. For example, a native application should be able to play a
sound when it receives an answer, but `proc.run.finished` alone does not mean
that the answer was directed to that application.

The shared primitive should be a protocol peer. A peer speaks GSV frames under
an authenticated identity and an explicit capability set. WebSocket and
service binding are transports for peers, not separate application models.

## Core model

Keep these concerns independent:

1. **Principal:** who the peer is acting as.
2. **Transport:** how request, response, and signal frames move.
3. **Facilities:** which parts of the protocol the peer may use.

An illustrative shape is:

```ts
type ProtocolPeer = {
  peerId: string;
  principal: PeerPrincipal;
  capabilities: string[];
  transport: "websocket" | "service-binding";
  facilities: {
    syscalls: boolean;
    signals: string[];
    interactiveInput: boolean;
    routedOutput: boolean;
    syscallTarget?: boolean;
  };
};
```

This is not intended as a final public type. It records the important
separation: identity does not imply a transport, and a transport does not imply
authority or protocol facilities.

The current mutually exclusive connection roles may remain authentication
categories during migration, but they must stop determining the entire runtime
surface. Facilities are additive and explicitly authorized.

Examples:

| Participant | Principal | Transport | Facilities |
|---|---|---|---|
| Native application | authenticated human | WebSocket | syscalls, signals, interactive input, routed output |
| Web application | authenticated human | WebSocket | syscalls, signals, interactive input, routed output |
| CLI | authenticated human | WebSocket | syscalls and signals, optionally interactive input and routed output |
| Machine daemon | device identity | WebSocket | selected syscalls, signals, syscall-target execution |
| Telegram transport control | service identity | service binding | adapter lifecycle and provider operations |
| Linked Telegram conversation | delegated human identity | service binding | restricted syscalls, interactive input, routed output |

The Process remains the only durable conversation and agent-history primitive.
A peer is not another chat record, process, agent, or notification inbox.

## Adapters as protocol peers

An adapter Worker has two distinct authorities that must not be conflated.

The Worker itself is a service peer. It authenticates provider traffic, owns
provider state, normalizes identities and media, and performs delivery. It may
call only its service-level control operations.

A linked external actor can produce a delegated user peer context for one
request or interaction. The Kernel derives the local user from its owned
identity link. Neither the adapter nor the external actor may select a local
uid.

```text
provider event
  -> authenticated adapter service peer
  -> Kernel resolves the owned actor link
  -> delegated user peer with attenuated capabilities
  -> ordinary syscall dispatcher
```

The delegated peer's effective capabilities are the intersection of:

- the linked user's authority;
- the operations allowed through that adapter or surface; and
- any explicit user policy for that connection.

An adapter can therefore expose more GSV functionality without acquiring root
or full login authority. A Telegram `/list` command can invoke the ordinary
`proc.list` syscall as the linked user, while account administration, secret
management, or other inappropriate capabilities remain unavailable.

The current behavior that synthesizes a privileged service identity for a
service-binding frame is suitable for the adapter control plane, but it must
not become the identity for delegated user syscalls.

## Shared command frontends

Slash commands and native UI actions should be presentations of ordinary
syscalls, not adapter-only features.

```text
/list            -> proc.list
/home            -> canonical routing operation
/where           -> canonical routing query
approve or deny  -> proc.hil
```

A shared command registry can define parsing, required syscall, bounded output
formatting, and help metadata. Telegram, WhatsApp, and other text transports use
that registry. Native and web applications normally call the structured
syscall directly and may use the same metadata for menus or command palettes.

Provider-specific syntax remains in the adapter. Authorization and behavior
remain in the Kernel syscall boundary. No command may become more powerful
because a transport parsed it locally.

## Exact routed output for every peer

Owner-wide process signals and directed interaction output have different
meanings and should remain different protocol events.

`proc.run.*` and `proc.changed` describe process execution and persisted state.
They may be observed by multiple clients and are useful for streaming,
inspection, synchronization, and control. They do not by themselves mean that
a user-facing answer was addressed to the observing client.

When an interactive run owes an answer to its origin, the Kernel should emit a
canonical routed output frame. An illustrative shape is:

```ts
type InteractionMessageSignal = {
  type: "sig";
  signal: "interaction.message";
  payload: {
    deliveryId: string;
    runId: string;
    processId: string;
    text: string;
    media?: InteractionMedia[];
  };
};
```

The exact name and payload require protocol design. Its semantic meaning is
fixed: this is an assistant message addressed to this peer through the exact
run route.

- An adapter renders it into the provider's message format.
- Native renders it in the active interaction and may play a local sound.
- Web renders it and may update its own local presentation.
- A TTY prints it.

This does not introduce GSV notifications. Sound, badges, desktop alerts, and
other presentation choices remain client-owned reactions to an addressed
message. Background execution continues to be represented by process state and
signals unless a separate product decision deliberately routes its output to a
peer.

Human-in-the-loop requests may need an analogous exact routed frame while
retaining the existing owner-wide ability to inspect and answer a pending
request. That decision must preserve the exact request-id authorization
contract.

## Shared interactive admission and routes

Interactive input from any peer should cross one Kernel-owned admission
boundary. That boundary resolves the selected Process, allocates or validates
the run identity, and installs the exact reply route before the Process can
emit output.

The route records a logical peer delivery handle plus the immutable context
needed by its transport. The final transport is selected only when delivering:

- a WebSocket transport writes the canonical frame to the live connection;
- a service-binding transport invokes the adapter's delivery operation;
- the adapter retains provider-specific reply ids, formatting, retry state,
  and idempotency in its own boundary.

The common protocol must not pretend all transports have identical durability.
A disconnected WebSocket can recover committed output from Process history.
An adapter may provide store-and-forward delivery with a durable provider
ledger. Those are transport properties beneath the same directed-message
semantics.

Owner-wide observation remains separate from the exact route. A client may
observe many Processes while only receiving an `interaction.message` when one
of its own interactive runs produces the answer owed to it.

## Transport-independent frame handling

The Gateway should have one authenticated frame-dispatch path after transport
setup. WebSocket handling and service-binding handling should adapt their input
into the same peer context, body ownership, cancellation, capability checks,
dispatch, and post-dispatch behavior.

Service-bound peers also need a supported way to receive asynchronous routed
frames. This may be a reverse service-binding callback or another explicit
delivery interface. It must preserve stable delivery identities and must not
be implemented by polling broad process signals.

The existing facts make this an evolutionary refactor rather than a new
protocol stack:

- service bindings already carry the public `Frame` representation;
- WebSocket and Process requests already converge on the syscall dispatcher;
- run routes already distinguish exact connection and adapter replies;
- adapters already own provider delivery retries and formatting.

The work is to remove the artificial restrictions and duplicated semantic
paths without weakening identity or delivery boundaries.

## Security invariants

- The Kernel derives every local user identity. An adapter never supplies a
  trusted uid, group list, capability list, installation id, or Process owner.
- The managed installation remains the outer address and security boundary.
- Adapter service authority and delegated external-user authority remain
  separate contexts.
- Effective delegated capabilities are attenuated and fail closed. Linking a
  messaging identity does not grant the equivalent of a password login.
- A service binding authenticates participation in the deployment graph; it
  does not authorize arbitrary user impersonation.
- Exact routes, peer handles, provider ids, message ids, and connection ids are
  not credentials. Delivery rechecks the owned route and current authority.
- Request and response bodies retain one owner and one terminal outcome across
  both transports.
- Provider replay, delayed delivery, relinking, and installation lifecycle
  fences remain adapter-owned where provider state is required.
- A peer cannot advertise facilities or subscribe to signals beyond the
  capabilities granted by the Kernel.

## Non-goals

This proposal does not:

- turn adapters into hardware syscall targets;
- grant messaging identities all permissions held by the linked human;
- move provider SDKs, formatting, webhooks, retries, or credentials into the
  Kernel;
- create a general notification subsystem or offline client inbox;
- make every process signal a directed message;
- replace Processes with client sessions or provider conversations;
- require equal delivery guarantees from WebSockets and third-party messaging
  providers; or
- approve the separate universal routing graph proposal.

## Relationship to surface bindings

`interaction-surface-bindings.md` explores durable Process bindings and output
graphs. This proposal addresses a lower protocol asymmetry: who may speak GSV
frames and how exact interactive input and output cross transports.

Protocol peers should be designed first. A later surface-binding design can
then use peer delivery handles instead of independently inventing separate
client and adapter mechanisms. Nothing in this document requires durable
output edges, offline client delivery, or a general routing graph.

## Suggested implementation sequence

Do not begin this sequence until the managed staging and native application
work designated ahead of it is stable.

1. Specify the peer identity, capability attenuation, facility negotiation,
   and transport-independent request context without changing behavior.
2. Refactor WebSocket and service-binding request handling to share body,
   cancellation, capability, dispatch, and post-dispatch ownership.
3. Add a Kernel-derived delegated user context for linked adapter actors and
   prove that the adapter cannot choose or widen it.
4. Define one interactive admission call and one exact routed output frame.
5. Deliver that frame through both live WebSockets and existing adapter
   callbacks while preserving adapter retry ledgers.
6. Move bounded adapter commands onto the shared command-to-syscall registry.
7. Migrate native and web clients to use exact routed output for addressed
   message presentation while retaining process signals for observation.
8. Remove superseded adapter-only command and connection-versus-adapter reply
   branches after compatibility gates are satisfied.

Each stage needs cross-transport tests. At minimum, the same linked owner must
receive equivalent results through native/WebSocket, Telegram/service binding,
and a direct SDK client; foreign actors, unlinked actors, restricted
installations, capability widening, stale routes, duplicate ingress, body
cancellation, and disconnects must fail without changing Process state.

## Open decisions

- Whether a delegated adapter peer is durable, interaction-scoped, or a
  stateless context reconstructed for each authenticated ingress.
- How a service-binding peer registers its reverse delivery callback without
  allowing another bound service to impersonate it.
- Which capability profile each first-party adapter receives by default and
  how users inspect or narrow it.
- Whether routed streaming is part of the first version or only terminal
  messages are standardized initially.
- Whether the command registry belongs in the public SDK, the Kernel, or a
  shared package with Kernel-owned execution.
- How existing connection and adapter run-route rows migrate without moving or
  duplicating already-admitted replies.

