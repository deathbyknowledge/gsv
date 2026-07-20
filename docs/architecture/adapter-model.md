# The Adapter Model

Use this page when you want to understand how GSV connects external messaging
systems such as WhatsApp and Discord to the same durable process model used by
the CLI and Desktop.

## Why adapters exist

An agent that only lives in a terminal is not very useful as personal
infrastructure. You want to reach the same system from the Desktop, the CLI,
WhatsApp, Discord, and eventually other surfaces.

The naive design would be to bundle every external messaging integration directly
into the Gateway. That creates three bad outcomes:

- bigger deploy bundles with more SDK and compatibility baggage
- a larger blast radius when one integration misbehaves
- tighter coupling between message transport code and Kernel routing logic

GSV avoids that by isolating each external integration behind an adapter worker.

## What an adapter does

An adapter is responsible for:

- talking to one external platform protocol
- maintaining any platform-specific connection state
- translating inbound events into normalized GSV adapter messages
- translating outbound GSV replies back into platform-specific format

The Kernel does not need to know how WhatsApp or Discord work internally. It only
needs a normalized control surface.

## Why the docs still say `channel-*` in some commands

User-facing docs prefer **adapter** because that is the better product term.
Some deployed components and worker names still use `channel-*` because those are
the current implementation names and CLI flags.

For example:

```bash
gsv infra deploy -c channel-whatsapp
gsv infra deploy -c channel-discord
```

That is a naming artifact in the implementation, not a separate concept.

## Service bindings and trust

Adapter workers connect to the Gateway through Cloudflare service bindings. That
means communication is internal to the deployed Cloudflare application graph,
not exposed as random public webhooks between your own components.

This gives GSV:

- internal-only worker-to-worker communication
- lower overhead than extra HTTP surfaces between your own services
- a clearer separation between transport logic and Kernel routing

Trust is established at deploy time, but it is not ambient. Each adapter binds
to an adapter-specific Gateway entrypoint that accepts only that adapter's
normalized `adapter.inbound` and `adapter.state.update` frames. The generic
Gateway entrypoint rejects adapter frames, and a scoped binding rejects frames
claiming another adapter.

The scoped entrypoints are a coordinated hard cutover, not a mixed-version
compatibility path. Deploy the Gateway exporting them and every adapter using
the matching binding as one rollout; old generic bindings fail closed.

## Inbound flow

The inbound path looks like this:

1. A platform event arrives at the adapter worker.
2. The adapter normalizes it into a GSV adapter message.
3. The adapter calls the Gateway service binding with `adapter.inbound`; it does
   not send a trusted username or uid.
4. The adapter-specific Gateway entrypoint rejects frame bodies and extracts an
   exact, bounded routing envelope: adapter, account, external actor, frame id,
   and surface kind/id. Message text, media, reply context, and the full frame
   remain at the Gateway boundary.
5. `singleton` receives only that envelope. It resolves the authoritative
   identity link and placement, then returns either a compact unknown-actor
   challenge/drop response, an explicit legacy route, or an active placement
   plus a short-lived one-shot delivery authorization. It never receives or
   awaits the active user's full message frame.
6. For an active placement, the Gateway sends the full frame directly to the
   user Kernel with the exact owner uid, Kernel generation, link generation,
   and one-shot authorization. The target consumes that authorization at the
   Master, which rechecks the current link and placement, then rechecks its own
   lifecycle before dispatch. Generic direct adapter delivery fails closed.
7. Only a linked actor whose placement is explicitly `legacy` sends the full
   frame through `singleton`.
8. The message is delivered to a durable process, usually `init:{uid}` or a
   routed process.
9. The process runs the normal agent loop and emits `proc.run.*` signals.

The important point is that inbound adapter traffic does not create a special
kind of bot runtime. It feeds the same durable process model that the CLI and
Desktop use.

## Outbound flow

The outbound path is the reverse:

1. A process produces text or tool-driven output.
2. The owning user Kernel decides which surface should receive it.
3. If that surface is an adapter route, the user Kernel sends the reply through the adapter worker.
4. The adapter worker formats it for the target platform and delivers it.

Again, the adapter is a transport surface, not the place where durable agent
state lives.

Adapter-backed shell targets are a separate command surface. Active user
Kernels do not yet receive the Master adapter-account/status/link projection
needed to discover those targets, so adapter-shell discovery remains a
multiuser release gate even though inbound and outbound messaging are routed.

## Identity linking

External actors are not automatically local users.

GSV uses identity links so that a WhatsApp sender or Discord user can be mapped
to an immutable canonical username and local uid. That mapping selects the
owning user Kernel and allows inbound messages to reach the right process and DM
replies to satisfy pending human-in-the-loop approvals. A payload username is
never trusted as that mapping.

The Master Control Program owns global adapter-account and identity-link
uniqueness and performs the current per-message metadata lookup. That lookup is
not a payload relay: active-user and unknown-actor text, media, reply context,
and frames do not enter `singleton`. Publishing bounded, generation-bound link
projections to the trusted adapter worker and owning user Kernel would remove
the remaining per-message lookup and is future work. Unknown actors can use
only the account's linking route, which the Master can answer from bounded
actor and surface metadata.

Without a link:

- direct messages can receive a link challenge
- non-DM messages from unknown actors can be dropped

## Surface routing

After an actor is linked, the owning user Kernel can route a given adapter
surface to a specific process.

That means you can choose whether inbound adapter traffic goes to:

- the default init process
- a specific task process
- a different routed process for a specific account or surface

This is what lets GSV keep one durable process model while still supporting
multiple external surfaces.

## Platform-specific quirks stay inside the adapter

Adapters exist partly because messaging platforms are messy.

Examples:

- WhatsApp pairing uses QR state and reconnection logic.
- Discord uses a bot token and long-lived gateway connection behavior.
- Platforms differ in media support, typing indicators, group semantics, and peer identity shapes.

Those quirks belong inside the adapter worker, not in the Kernel or process
runtime.

## Why this matters

The adapter model keeps GSV coherent.

Without it, every external integration would drag platform details into the core
runtime. With it, GSV can treat WhatsApp, Discord, the CLI, and the Desktop as
multiple surfaces into the same computer.

## See also

- [Connect a Messenger](../how-to/messengers)
- [Routing Reference](../reference/routing.md)
- [Architecture Overview](./index.md)
