# The Adapter Model

Use this page when you want to understand how GSV connects an open-ended set of
external messaging systems to the same durable process model used by the CLI
and Desktop. WhatsApp, Discord, Telegram, and Slack are bundled adapter
implementations, not a closed list of transports recognized by the Kernel.

## Why adapters exist

An agent that only lives in a terminal is not very useful as personal
infrastructure. You want to reach the same system from the Desktop, the CLI,
the bundled messengers, and adapters written for services GSV has never seen.

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

An adapter's messaging projection is not automatically an execution target.
Most bundled adapters do not appear in the `targets` shell inventory or the
model's available-target list because they do not implement targetable syscalls.
Managed Slack is the first adapter-backed exception: after personal OAuth and
pairing it advertises a `shell.exec` target containing the provider-owned
`slack` CLI. The compatibility `sys.device.*` API and Machines console remain
hardware-oriented and do not administer service-backed targets.

Messaging has its own two deliberate views:

- `message destinations` is the agent-facing inventory of authorized observed
  conversations where a message can be delivered.
- Adapter APIs and the Messengers console expose account connection, health,
  identity-link, and administration state.

This keeps a transport-only Telegram account from masquerading as a capability
environment while preserving the adapter as the platform-specific owner of
delivery. An adapter account may independently provide a target when it exposes
a coherent filesystem, command environment, or other target primitives. The
adapter still owns provider identity, credentials, formatting, retries, and
delivery policy; target routing does not move those concerns into the Kernel.

See [Targets and Capability Environments](./targets.md) for the target-provider
contract and the distinction between peers, adapters, machines, and targets.

## Why deployment names still say `channel-*`

User-facing docs prefer **adapter** because that is the better product term.
Some deployed components and worker names still use `channel-*` because those
are compatibility names in release artifacts and service bindings. Each
adapter's `adapter.json` owns that deployment metadata; the public Alchemy stack
discovers it without a fixed adapter list.

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

Managed email follows the same transport ownership rule but is not a chat
identity surface. Email Routing delivers `<installation-handle>@gsv.space` to
the email Worker. The Worker resolves the handle through Accounts before
addressing its installation-scoped transport Durable Object, persists an exact
retryable copy, and hands the message to the Gateway over a service binding.
The Kernel owns the canonical mailbox, filesystem paths, local user assignment,
and delivery to the owner's Personal intelligence. The adapter deletes its raw
outbox chunks after the Kernel acknowledges durable storage; it retains only
bounded delivery and usage state.

The handoff has two phases. Raw mail is stored first so inference failure never
hides a message. A separate fixed, no-tools summarization call produces bounded
metadata, which the Kernel stores on one deduplicated `mail.received`
responsibility for Ship. The record contains the opaque message ID, receipt time,
bounded summary, category, attention flag, and optional confidence. It omits
separate mailbox identifiers, address fields, display names, subjects, raw headers,
and message bodies. Its title contains only the opaque id, so sender-controlled
summary text enters model context only after Ship explicitly inspects the record.
The summary remains untrusted external context. Upgrades preserve historical Inbox
accounts, processes, and mailbox notification fields, but new mail neither consults
nor updates them.

Normalized message and body types live in
`packages/gsv/src/protocol/adapters.ts`. The Worker RPC extension point is
`AdapterService` in `packages/gsv/src/services/adapters.ts`. Every adapter
returns a descriptor for lifecycle, status, activity, pairing, surface, and
media support, plus an explicit target-support bit when applicable. Adapters
call the Gateway's single `serviceFrame` entrypoint for `adapter.inbound` and
`adapter.state.update`.

The canonical adapter identity comes from the trusted `CHANNEL_*` service
binding. A descriptor must agree with that identity and cannot grant its Worker
additional authority. Adding an adapter therefore extends deployment metadata
and provider code rather than a Kernel enum.

A successful `adapterStatus` result is an authoritative account observation. If
the account RPC itself fails, the adapter propagates that failure instead of
synthesizing a disconnected or unauthenticated status; the Gateway retains its
last known state. Autonomous provider state changes use `adapter.state.update`.

Every call in either direction begins with a validated installation context.
The Kernel supplies that context from its durable installation identity; it is
not read from adapter message arguments or a public request. First-party
adapters use it to derive the account Durable Object name. The object recovers
the same immutable installation and account identity from its name instead of
persisting a second, mutable copy alongside provider state. Managed shared apps
are deliberately different from installation-owned accounts. Telegram derives
one peer Durable Object from the authenticated private Telegram identity. Slack
first admits the signed event through the installed workspace record, then
derives a peer from that workspace and human author; a public Slack request
still cannot select a GSV installation or local uid. Each peer owns an
exclusive route containing the installation, local uid, and a fresh generation.
Inbound records and queued replies retain that generation and recheck it
immediately before crossing the Gateway or provider boundary, so delayed work
cannot cross a relink. Slack additionally requires the exact public channel or
thread to have been observed for that author before it will deliver there.

Managed account objects use a collision-free internal name derived from
`installationId` and the installation-local `accountId`. The explicit
`singleton` compatibility installation retains the historical unscoped
account name, so upgrading a standalone Telegram, Discord, WhatsApp, or test
adapter reaches its existing Durable Object and provider session. Adapter
alarms and retries recover the installation context from the named Durable
Object before calling the Gateway. Managed Telegram and Slack recover it from
the peer's generation-fenced active route. They do not depend on a browser
hostname.

## Inbound flow

The inbound path looks like this:

1. A platform event arrives at the adapter worker.
2. The adapter normalizes it into a GSV adapter message.
3. The account Durable Object recovers its installation identity and
   sends `adapter.inbound` through the Gateway's `serviceFrame` binding with
   that trusted context, its stable account-scoped ingress `deliveryId`, and an
   optional top-level media body.
4. The Kernel resolves the adapter account and external actor.
5. The Kernel checks the identity link and non-DM activation policy.
6. A private DM updates the owner's last-active linked private destination and
   resolves SHIP or an explicit work override. A shared surface
   resolves its actor/thread-scoped persisted route.
7. Media is streamed into process-owned storage, the canonical conversation input
   is committed, and the Kernel creates the run's directed endpoint before admission.
8. The message is delivered to the routed process with its conversation and
   canonical input-message identities. Unrouted private DMs converge
   on the owner's canonical personal controller without writing a route; an
   unrouted group, channel, or thread starts and binds a separate interactive
   process running as the owner's personal agent.
9. The process runs the normal agent loop. Raw `proc.run.*` activity is inspectable;
   only an explicit terminal `message send` becomes user-visible conversation output.

The important point is that inbound adapter traffic does not create a special
kind of bot runtime. It feeds the same durable process model that the CLI and
Desktop use.

## Outbound flow

The canonical outbound path is:

1. A process runs terminal `message send` through Shell. Ordinary assistant text remains
   raw Process activity; a bare `yield` finishes without another Message.
2. The Kernel commits the Message to the canonical conversation and looks up the
   exact directed endpoint created during admission.
3. If no conversation identity or exact route exists and this is a background run
   in the canonical personal controller, the Kernel may materialize an adapter route
   from the owner's last-active linked private destination. A disconnected client
   conversation never jumps to an adapter, and other processes never use the fallback.
4. The Kernel rechecks the linked actor's destination authority.
5. If the endpoint is an adapter, the Kernel durably queues `message.committed` for
   that adapter. Adapters never receive Process token or reasoning streams.
6. The adapter buffers the committed message, formats it for the provider, and delivers it.
7. Other signed-in clients synchronize the canonical message without treating it as
   directed to them.

Again, the adapter is a transport surface, not the place where durable agent
or conversation state lives.

The `message` shell command exposes delivery context and the explicit path for a
separate or cross-channel message. `message current` describes the directed endpoint
and includes its opaque destination id when it is an adapter surface,
`message destinations` lists authorized observed surfaces, and `message attach`
registers files for the next current-conversation message. A literal `message send <<'GSV_MESSAGE'` block sends without finishing the run
on its directed endpoint. `message send --to ... --also` sends a separate message. `--also` is
required for every separate send during an active run,
preventing an accidental duplicate.

`message route` is the process-facing control for persistent group, channel,
and thread mappings. It selects destinations through `here`, opaque GSV ids, or
unambiguous generic labels rather than provider fields, and only accepts owned
interactive processes. The canonical personal process may also set a private
DM to an owned non-personal process when that exact latest DM message started
its current run. This opens an explicitly labeled INTERNAL WORK / WORK SESSION;
the human uses `/ship` for the canonical SHIP.
Changing a selection does not change an existing run route: the current Message
stays directed to its origin, while the next inbound message enters the new selection.

Managed outbound email has a separate explicit path because email is a mailbox,
not an observed chat surface. `mail.send` accepts one recipient and a plain-text
body capped at 1 MiB in version one, or `replyToMessageId` to derive the
recipient and threading headers from a message in the caller's canonical
mailbox. The Kernel derives the sender from the active human owner's mailbox.
`mail send` and `mail reply` expose the same operation through the native
shell; CodeMode exposes it as `mail.send`.

The Kernel owns the canonical outbound intent. It binds a caller-selected or
deterministically derived `deliveryId` to the exact owner, destination, reply
context, headers, and body digest in Kernel SQLite, then stores the text once in
installation-scoped R2. Replaying an exact intent returns its current state;
reusing the id for different content fails closed. The Queue carries only an
installation-scoped `outboundId` and fingerprint. The email Worker first admits
that trusted reference to the installation-scoped email Durable Object. The DO
then resolves Accounts and claims the canonical draft and body over the Gateway
binding before contacting a provider, so a transient dependency outage cannot
exhaust Queue retries and lose the intent.

An installation-scoped email Durable Object owns the delivery ledger, daily
message and byte reservations, claim retries, and completion callback retries.
It independently derives and persists the expected sender on the first
successful active Accounts resolution. Later handle drift fails closed, and a
mismatched draft is rejected rather than trusting the claimed `from` field.
Cloudflare Email Sending is called at most once after the DO durably records an
attempt. Provider acceptance records `accepted`.
Lifecycle, quota, and draft validation failures before that attempt record
`failed`; a crash, binding throw, or malformed provider result after the attempt
records `unknown` and is never replayed, because the message may already have
left the provider boundary.

This service exists only in the Humans & Machines managed graph. Standalone GSV
does not deploy the email Worker, Queue, provider binding, or managed
`mail.send` transport.

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
`deliveryId`. Committed run Messages, schedule occurrences, and the `message`
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
Process. The canonical Message remains in conversation history and its delivery
outcome remains inspectable in Process activity. Approval attempt one is durably queued before Process acknowledges the
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

After an actor is linked, a private DM defaults to the owner's one canonical
personal controller. No default route row is stored. At the user's request,
that controller can open a direct line to an existing non-personal process;
the current answer confirms it and the next message enters work. The Kernel
rejects a late handoff if a newer private message or selection won. `/ship`
clears the override immediately and gives the personal controller a typed
return event containing the work PID without mirroring the transcript. Tokened
HIL decisions search only the owner's `waiting_hil` interactive processes,
which preserves approval correlation after leaving a work session.

Groups, channels, and threads use actor-scoped surface routes. Their key
includes adapter, account, actor, surface kind, surface id, and optional thread
id. When none exists, the shared surface starts and binds an independent
interactive process running as the owner's personal agent. `message route`
remains available for these non-private surfaces.

This is what lets GSV keep one durable process model while still supporting
multiple external surfaces. Actor scope is important: two linked GSV users can
participate in one shared group or channel without overwriting one another's
process selection or destination authority.

## Media and the filesystem

Adapter JSON carries media metadata, while one optional top-level binary body
carries the bytes. Body-backed items point at contiguous `{ offset, length }`
ranges in media-array order. The body is consumed sequentially with one owner;
failure or cancellation cancels the remaining stream. Current Gateway limits
are 20 items, 48 MiB per item, and 48 MiB total.

Inbound bytes stream through a private Process RPC into one immutable object in
the run-as agent archive. The admitted message carries a revision-bound resource
reference; model context, clients, and outbound adapters resolve that same
reference lazily. A file on a connected machine can travel the other direction
through `fs.transfer.send`; `message attach` retains the exact revision before
the terminal Message is committed. No adapter or conversation layer makes an
additional byte copy.

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

V023 adds the unique per-owner personal-controller slot. V024 adds explicit
`legacy`, `work`, and `surface` route modes: existing private rows drain as
legacy while existing non-private rows remain shared-surface routes. V025 adds
the one-per-owner last-active private adapter destination. Its timestamp-aware
upsert prevents an older provider replay from replacing newer private activity,
and future timestamps are clamped to receipt time so they cannot freeze the
pointer. Every fallback still rechecks the live identity link before delivery.

V035 gives each adapter account an opaque lifecycle identity and records the owner
for whom that account has already been observed connected and authenticated. The
migration backfills this owner-scoped readiness for existing ready human-owned
accounts, so a transport-only reconnect after upgrade cannot look like a newly
connected account.

## Platform-specific quirks stay inside the adapter

Adapters exist partly because messaging platforms are messy.

Examples:

- WhatsApp pairing uses QR state and reconnection logic.
- Discord uses a bot token and long-lived gateway connection behavior.
- Platforms differ in media support, typing indicators, group semantics, and peer identity shapes.

Those quirks belong inside the adapter worker, not in the Kernel or process
runtime.

## Adding an adapter

1. Implement `AdapterService` in a separate Worker and return a truthful,
   versioned descriptor from `adapterDescribe`.
2. Keep one account's provider lifecycle in its owning Durable Object.
3. Normalize stable actor and surface identifiers, and derive one account-scoped
   ingress delivery id from the provider's complete event identity.
4. Persist reconstructable ingress before the first Gateway call and retry it
   with the account's existing wake-up mechanism until a terminal disposition.
5. Implement mention/reply activation for every supported non-DM surface.
6. Use the shared binary-body helpers and common media limits.
7. Exercise DM linking, shared surfaces, media cancellation, reconnects,
   request-bound approvals, duplicate ingress, canonical Messages, and directed
   endpoint routing.
8. Add an `adapter.json` beside the implementation. The release and deployment
   tools discover adapter directories and derive component identity, service
   bindings, entrypoints, Durable Objects, required secrets, and deployment
   order from that file. No central adapter list or CLI change is required.

## Why this matters

The adapter model keeps GSV coherent.

Without it, every external integration would drag platform details into the core
runtime. With it, GSV can treat any provider adapter, the CLI, and the Desktop as
multiple surfaces into the same computer.

## See also

- [Connect a Messenger](../how-to/messengers)
- [Routing Reference](../reference/routing.md)
- [Architecture Overview](./index.md)
