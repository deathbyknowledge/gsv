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

Trust is established at deploy time. If the binding exists, that adapter worker
is part of the trusted deployment.

## Inbound flow

The inbound path looks like this:

1. A platform event arrives at the adapter worker.
2. The adapter normalizes it into a GSV adapter message.
3. The adapter calls the Kernel with `adapter.inbound` using a service identity.
4. The Kernel resolves the adapter account and external actor.
5. The Kernel checks identity links and routing state.
6. The message is delivered to a durable process, usually `init:{uid}` or a routed process.
7. The process runs the normal agent loop and emits `chat.*` signals.

The important point is that inbound adapter traffic does not create a special
kind of bot runtime. It feeds the same durable process model that the CLI and
Desktop use.

## Outbound flow

The outbound path is the reverse:

1. A process produces text or tool-driven output.
2. The Kernel decides which surface should receive it.
3. If that surface is an adapter route, the Kernel sends the reply through the adapter worker.
4. The adapter worker formats it for the target platform and delivers it.

Again, the adapter is a transport surface, not the place where durable agent
state lives.

## Identity linking

External actors are not automatically local users.

GSV uses identity links so that a WhatsApp sender or Discord user can be mapped
to a local uid. That mapping is what allows inbound messages to reach the right
process and allows DM replies to satisfy pending human-in-the-loop approvals.

Without a link:

- direct messages can receive a link challenge
- non-DM messages from unknown actors can be dropped

## Surface routing

After an actor is linked, the Kernel can route a given adapter surface to a
specific process.

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
