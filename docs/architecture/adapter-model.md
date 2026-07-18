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

Adapters are not execution targets. They do not appear in `sys.device.list`,
the `targets`/`devices` shell inventory, the model's available-target list, or
the Machines console. Those surfaces contain only places where targetable
syscalls can run: GSV, connected devices, and browser-backed targets.

Messaging has its own two deliberate views:

- `message destinations` is the agent-facing inventory of authorized observed
  conversations where a message can be delivered.
- Adapter APIs and the Messengers console expose account connection, health,
  identity-link, and administration state.

This keeps a Telegram account from masquerading as a machine while preserving
the adapter as the platform-specific owner of delivery.

## Why deployment names still say `channel-*`

User-facing docs prefer **adapter** because that is the better product term.
Some deployed components and worker names still use `channel-*` because those are
compatibility names in infrastructure commands and bindings.

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

The protocol source of truth is `packages/gsv/src/protocol/adapters.ts`.
Gateway-to-adapter bindings expose lifecycle, status, activity, and send
operations; adapters call the Gateway's single `serviceFrame` entrypoint for
`adapter.inbound` and `adapter.state.update`.

## Inbound flow

The inbound path looks like this:

1. A platform event arrives at the adapter worker.
2. The adapter normalizes it into a GSV adapter message.
3. The adapter sends `adapter.inbound` through the Gateway's `serviceFrame`
   binding with its stable account-scoped ingress `deliveryId` and an optional
   top-level media body.
4. The Kernel resolves the adapter account and external actor.
5. The Kernel checks the identity link and non-DM activation policy.
6. The Kernel records the actor/thread-scoped observed surface and resolves its
   process route.
7. Media is streamed into process-owned storage, and the Kernel creates the run
   reply route before admitting the message.
8. The message is delivered to a durable process, usually the user's personal
   conversation executor or a routed process.
9. The process runs the normal agent loop and emits `proc.run.*` signals.

The important point is that inbound adapter traffic does not create a special
kind of bot runtime. It feeds the same durable process model that the CLI and
Desktop use.

## Outbound flow

The automatic outbound path is the reverse:

1. A process produces terminal output.
2. The Kernel looks up the exact run route created during admission.
3. It rechecks the linked actor's destination authority.
4. If the route is an adapter route, the Kernel sends the reply through the
   adapter worker.
5. The adapter worker formats it for the chat platform and delivers it.

Again, the adapter is a transport surface, not the place where durable agent
state lives. The agent normally returns its final answer without calling an
explicit send operation.

The `message` shell command is the explicit path for an additional or
cross-channel message. `message current` describes the automatic route,
`message destinations` lists authorized observed surfaces, `message attach`
registers files on the run's automatic final response, and `message send --to ...`
sends text or one filesystem attachment as an extra message. An explicit
send to the current automatic destination requires `--also`, preventing an
accidental duplicate final reply.

Each adapter derives a stable account-scoped ingress `deliveryId` from the
provider's complete event identity. For example, WhatsApp includes the group
participant as well as the stanza id. Before link, command, approval, routing,
media, or Process side effects, the Kernel claims a durable receipt for that
id. The actor and surface are recorded for audit and authorization but are not
part of receipt identity, because provider aliases may normalize after the
first delivery. A completed replay returns the stored disposition; a
concurrent replay on the live Kernel observes the active claim, while an
abandoned or post-restart claim is fenced and reclaimed. Checkpoints bind HIL
decisions to their exact request and preserve staged media plus the stable
Process run id, so reconciliation cannot turn an old approval into a new turn
or upload the same media again. Both paths cancel any repeated media body before
staging bytes. A Process admission predating the receipt migration reports
whether that run is active, queued, or already recorded so the Kernel cannot
resurrect a completed run's reply route or typing state.

The adapter owns the handoff until the Kernel reaches a terminal disposition.
Discord stores the compact provider event as JSON, Telegram stores the
message-bearing update payload keyed by update id, and WhatsApp stores the
protobuf message in their existing account Durable Object storage before the
first Gateway call. A transport failure or `replayed: "in_progress"` leaves the
record pending; the account's existing alarm retries it and rebuilds any media
body from the provider payload. The payload and its earliest alarm are committed
in one storage transaction. An alarm re-arms pending work before retry I/O, so a
worker failure cannot leave a durable record without a wake-up. This uses the
account's existing storage and wake-up mechanism rather than introducing a
second ingress scheduler or blob store.

Command replies, link challenges, and HIL acknowledgements use the receipt's
stable delivery ids. The Kernel prepares and completes the receipt with the
exact result. Before provider delivery, the adapter replaces its durable raw
payload with normalized response records. It then passes each response through
the same account-local outbound ledger used by normal sends. A response retry
therefore cannot re-enter the Kernel or renormalize actor identity. A crash
before that transition can replay the stable Kernel receipt without repeating
side effects; after it, a restart replays only the stored response with its
stable delivery id. Link challenges are skipped after their expiry, and
retry-safe response failures stop after ten durably counted attempts. Completed
Kernel receipts are capped and retained for seven days.

Outbound messages cross the adapter-worker boundary with a stable
`deliveryId`. Automatic run replies, schedule occurrences, and the `message`
CLI derive it before their first attempt. First-party
adapter account Durable Objects retain a bounded delivery ledger and return a
recorded success without contacting the provider again. Each ledger record also
binds the id to a fingerprint of its exact destination, reply context, text,
media metadata, and binary media bytes. Reusing an id with different content is
rejected instead of being mistaken for a successful replay, and that binding is
retained across retry-safe failures. Only failures known to be safe are
retryable. Outcomes that may already have reached a provider are reported as
ambiguous and are not replayed; Discord can additionally reuse an
enforced deterministic nonce, while Telegram and WhatsApp conservatively use
at-most-once delivery. The Kernel persists retry-safe terminal delivery as its
own scheduled work, stops typing after every attempt, and removes the reply
route after success or after a terminal delivery notice is accepted by the
Process. The answer remains in process history with an inspectable delivery
outcome. Approval attempt one is durably queued before Process acknowledges the
HIL signal; provider notification failure therefore cannot clear or fail a
pending approval.
Link challenges, adapter command responses, and human-approval acknowledgements
use this same outbound ledger. The Kernel derives their delivery ids before the
durable ingress claim and returns normalized response metadata. Provider
delivery begins only after the inbound Gateway RPC returns, so it does not make
a re-entrant call into the account Durable Object that is still reporting the
event. A repeated provider event therefore reaches the account-local ledger
instead of calling a raw platform reply helper.

## Identity linking

External actors are not automatically local users.

GSV uses identity links so that a WhatsApp sender or Discord user can be mapped
to a local uid. That mapping is what allows inbound messages to reach the right
process and allows DM replies to satisfy pending human-in-the-loop approvals.

Without a link:

- direct messages can receive a link challenge
- non-DM messages from unknown actors can be dropped

Linked group, channel, and thread traffic is not ambient input. The adapter must
set `wasMentioned: true` when the bot was addressed according to that
platform's mention or reply semantics. The Kernel drops other non-DM messages.

## Surface routing

After an actor is linked and addresses GSV on a surface, the Kernel can route
that observed destination to a specific process. The key includes adapter,
account, actor, surface kind, surface id, and optional thread id.

That means you can choose whether inbound adapter traffic goes to:

- the default init process
- a specific task process
- a different routed process for a specific account or surface

This is what lets GSV keep one durable process model while still supporting
multiple external surfaces. Actor scope is important: two linked GSV users can
participate in one shared group or channel without overwriting one another's
process selection or destination authority.

## Media and the filesystem

Adapter JSON carries media metadata, while one optional top-level binary body
carries the bytes. Body-backed items point at contiguous `{ offset, length }`
ranges in media-array order. The body is consumed sequentially with one owner;
failure or cancellation cancels the remaining stream. Current Gateway limits
are 10 items, 25 MiB per item, and 48 MiB total.

Inbound bytes are stored once under the owning process and exposed to the agent
at a stable read-only `/var/media/{uid}/{pid}/{id}` path. The agent can inspect
that path, copy it to a connected machine with target-aware `cp`, register it on
the automatic final reply with `message attach`, or attach it to an explicit
adapter message. Automatic attachments persist on the assistant history record,
so native GSV clients and adapters consume the same Process-owned reference. A
file on a connected machine can travel the other direction by copying it to GSV
first and passing the local path to `message attach` or `message send --attach`.

## Scheduled adapter delivery

`sched add --here` and `sched add --to` have different contracts:

- `--here` creates a process event. When called during an adapter run, it
  captures the current authorized adapter destination, wakes the same process
  later, and routes that future terminal answer back to the surface.
- `--to` creates a direct `adapter.send` schedule. It sends the supplied text
  without running an agent.

The durable destination retains the linked actor and exact surface/thread but
not transient display labels or the triggering message id. Authority is
rechecked when the destination is used.

## Route and ingress schema changes

Kernel migrations v009 and v010 deliberately discard legacy routing rows that
cannot be authorized under the current model. V009 binds run reply routes to
their process and linked actor and clears existing short-lived routes. V010
recreates surface routes with actor/thread scope and adds the triggering reply
id to run routes.

Deploying across this boundary clears existing per-surface process selections
and can remove in-flight legacy reply routes. The next authorized inbound
message observes the surface again. Guessing a migration from a globally scoped
surface to one of several linked users would be an unsafe compatibility grant,
so the cutover is intentionally explicit.

Kernel migration v013 adds the normalized ingress receipt table. The table is
additive, so it does not disturb routes or active runs. Claim tokens fence a
stale request, and durable progress/result checkpoints let a replacement Kernel
resume or reconcile the exact operation before completing the receipt. V014
adds the adapter-owned provider delivery id. During an upgrade, legacy receipts
are reused only when the old actor-scoped identity resolves unambiguously;
ambiguous legacy matches fail closed instead of repeating side effects.

## Platform-specific quirks stay inside the adapter

Adapters exist partly because messaging platforms are messy.

Examples:

- WhatsApp pairing uses QR state and reconnection logic.
- Discord uses a bot token and long-lived gateway connection behavior.
- Platforms differ in media support, typing indicators, group semantics, and peer identity shapes.

Those quirks belong inside the adapter worker, not in the Kernel or process
runtime.

## Adding an adapter

1. Implement the shared adapter worker interface in a separate worker.
2. Keep one account's provider lifecycle in its owning Durable Object.
3. Normalize stable actor and surface identifiers, and derive one account-scoped
   ingress delivery id from the provider's complete event identity.
4. Persist reconstructable ingress before the first Gateway call and retry it
   with the account's existing wake-up mechanism until a terminal disposition.
5. Implement mention/reply activation for every supported non-DM surface.
6. Use the shared binary-body helpers and common media limits.
7. Exercise DM linking, shared surfaces, media cancellation, reconnects,
   request-bound approvals, duplicate ingress, and final reply routing.

## Why this matters

The adapter model keeps GSV coherent.

Without it, every external integration would drag platform details into the core
runtime. With it, GSV can treat WhatsApp, Discord, the CLI, and the Desktop as
multiple surfaces into the same computer.

## See also

- [Connect a Messenger](../how-to/messengers)
- [Routing Reference](../reference/routing.md)
- [Architecture Overview](./index.md)
