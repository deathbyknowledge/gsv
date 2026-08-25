# The Adapter Model

Use this page to understand how GSV connects external messaging systems such as
WhatsApp, Discord, and Telegram to the same durable Process model used by the
CLI and Desktop.

## Why adapters exist

An agent that only lives in a terminal is not useful as personal infrastructure.
The same system should be reachable from the Desktop, CLI, and external
messaging surfaces without moving platform SDKs or delivery quirks into the
Gateway Kernel.

Each external integration therefore runs as an adapter worker. This keeps:

- platform SDK and compatibility baggage outside the Gateway bundle;
- an integration failure inside a smaller operational boundary; and
- transport behavior separate from identity, authorization, and Process state.

## Adapter responsibilities

An adapter owns:

- one external platform protocol;
- platform-specific connection, pairing, and reconnection state;
- normalization of inbound events into GSV adapter frames; and
- conversion of normalized outbound messages into platform delivery calls.

An adapter does not own GSV account identity, identity links, user-Kernel
placement, or durable agent state. Those remain Gateway concerns.

Some deployment commands still use the older `channel-*` component names:

```bash
gsv infra deploy -c channel-whatsapp
gsv infra deploy -c channel-discord
```

That is an implementation naming artifact, not a second concept.

## Service bindings and trust

Adapter workers call the Gateway through Cloudflare service bindings. The calls
remain inside the deployed application graph instead of exposing a generic
public webhook between GSV-owned Workers.

Trust is scoped, not ambient. Each adapter binds to an adapter-specific Gateway
entrypoint that accepts only that adapter's normalized inbound and state frames.
The generic entrypoint rejects adapter frames, and a scoped entrypoint rejects a
frame claiming a different adapter.

Deploy a Gateway entrypoint and its matching adapter binding as one coordinated
rollout. A mismatched or generic binding fails closed.

## Why the Master is on the message path

The Master Control Program (`singleton`) owns adapter accounts and the unique
mapping from an external actor to a canonical GSV username/uid. User Kernels do
not keep a durable copy of that authority. The current design therefore routes
adapter messages through the Master in both directions.

This is intentionally different from ordinary WebSockets, app bodies, devices,
and model streams, which stay on their user-owned data paths. It is a simple,
honest first implementation: each adapter delivery uses the current link record
and one direct Master-to-user RPC.

## Inbound flow

Inbound delivery works as follows:

1. A platform event arrives at the adapter worker.
2. The adapter validates and normalizes it into `adapter.inbound` with stable
   adapter, account, actor, surface, and message semantics. It does not claim a
   trusted GSV username or uid.
3. The adapter-specific Gateway entrypoint checks the binding scope and calls
   `singleton` with the frame.
4. The Master validates the bounded routing fields and resolves the live
   adapter account, identity link, link revision, and user-Kernel placement. If
   the known placement is `provisioning`, it idempotently completes provisioning;
   only `active` proceeds.
5. The Master calls the exact `user:<canonical-username>` Kernel with the
   original normalized frame and the resolved owner/link context.
6. The target verifies that the call came through the Master, that the owner uid
   matches its persisted active marker, and that the route is structurally
   valid before delivering the message to a Process.
7. The Process runs the ordinary agent loop and emits the usual `proc.run.*`
   signals.

There is no adapter-specific bot runtime. An adapter event feeds the same
durable Process model as the CLI and Desktop.

## Unknown actors and linking

An external actor is not automatically a local user. The Master-owned identity
link maps an `(adapter, account, actor)` tuple to an immutable canonical
username and uid. A payload username, uid, peer label, or reply address is never
trusted as that mapping.

Without a current link:

- a direct message can receive a short-lived, one-time, attempt-limited link
  challenge; and
- a group, channel, or thread event is dropped.

Consuming a link code authenticates the local user and creates the mapping. A
monotonic link revision prevents an unlinked route from becoming current again.
The first inbound message is not replayed after linking.

## Surface routing

Once linked, the owning user Kernel can route an adapter surface to:

- the default init Process;
- a specific task Process; or
- another Process selected for that account and surface.

The stored run route binds the adapter, account, actor, surface, owner uid, and
link revision. It is runtime routing state, not a replacement for the
Master-owned identity link.

## Outbound flow

Outbound delivery is the reverse authority path:

1. A Process produces output for an adapter-backed run route.
2. The owning user Kernel sends the normalized outbound request and stored route
   to the Master.
3. The Master revalidates the active owner, adapter account, external actor,
   surface, and link revision.
4. The Master invokes the matching adapter worker through its service binding.
5. The adapter formats and delivers the platform-specific message.

The Master must not accept an arbitrary return address or adapter identity from
Process output. Outbound delivery follows the route captured from an authorized
inbound event or another explicitly authorized adapter operation.

Adapter-backed shell targets are a separate command surface. They require an
explicit target and capability decision; a messaging identity link alone does
not grant shell access.

## Future scaling path

Adapter content currently traverses `singleton`, so adapter load is measured
separately from other user traffic. If that becomes material, the intended
optimization is a bounded ephemeral link cache in user Kernels:

- the Master remains the only durable link authority;
- the Master pushes link additions, changes, and invalidations;
- cache entries are short-lived and held only in memory;
- a cold start, miss, expired entry, or uncertain invalidation falls back to a
  live Master lookup; and
- no user Kernel writes or persists a competing link directory.

Do not add this mechanism before measurement shows that the direct Master route
is a bottleneck.

## Platform-specific behavior stays in the adapter

Messaging platforms differ in ways the core runtime should not absorb. For
example:

- WhatsApp pairing uses QR state and reconnection logic;
- Discord and Telegram have different gateway, bot-token, and polling behavior;
- media, typing indicators, group membership, threads, and peer identities have
  platform-specific shapes.

Those details belong in the adapter worker. The Gateway sees stable actor,
surface, message, attachment, and delivery semantics.

## See also

- [Connect a Messenger](../how-to/messengers)
- [Routing Reference](../reference/routing.md)
- [Multiuser Security Architecture](./multiuser-security.md)
- [Architecture Overview](./index.md)
