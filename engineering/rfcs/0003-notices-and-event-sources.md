# RFC 0003: Notices and Event Sources

Status: **proposed**

## Summary

Things happen to a person's Ship: a contact writes, mail arrives, work blocks on
them, a computer pairs, a messenger disconnects, a service they use fires a
webhook. Today each of these reaches the person, or the Ship, through its own
path, and most reach only an open browser tab.

This RFC makes every one of them an **event** that one Kernel-owned **policy**
turns into up to three independent outcomes:

```text
                         ┌─────────────── policy (per owner) ───────────────┐
 Kernel producers ──┐    │                                                  │
 clock (r12y due) ──┼──► │ event ─► match rule ─┬─► notify the person ──────┼─► messenger / OS / app
 webhook sources ───┤    │                      ├─► Ship sees it (context) ─┼─► ship_events
 MCP Events ────────┘    │                      └─► Ship acts (wake) ───────┼─► ship_events
                         └──────────────────────────────────────────────────┘
```

- **Notify** is deterministic: a template, no inference, the same text every time.
- **Ship sees** appends the event to the Ship's history without starting a run.
- **Ship acts** wakes the Ship, through the `ship_events` queue from RFC 0002.

Outside sources enter through one per-Ship receiver that speaks
[Standard Webhooks](https://www.standardwebhooks.com/) and the draft
[MCP Events extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415)
(SEP-3415), so a person's own webhooks and the MCP servers they already connect
share one door, one verification path and one policy.

## Today

Phase 1 (#579) added Kernel owner notices for three topics:

| Topic | Notify | Ship |
|---|---|---|
| `contact.request` | messenger notice with an Open button | `owner.notified` context event |
| `contact.message` (not Ship-handled, unread) | messenger notice, counted | `owner.notified` context event |
| `contact.invite.accepted` | messenger notice | `owner.notified` context event |

A notice goes to the owner's private messenger only when no client of theirs is
active, and it is dropped once its subject is read, decided, muted or ended.

Everything else has its own path or none:

| Happening | Reaches the person | Reaches the Ship |
|---|---|---|
| Approval requested on a messenger run | adapter renders the HIL buttons | it is the Ship's own run |
| Mail received | web inbox only | `mail.received` responsibility wake |
| Unread in the web app | `attention` on `message.committed` → tab title | — |
| Work blocked on the person / overdue | nothing; `dueAtMs` fires nothing | ledger wake |
| Computer paired | web only | lifecycle responsibility |
| Messenger channel broke | nothing on that channel, nothing elsewhere | lifecycle responsibility |
| An outside service's webhook | not possible | not possible |

## Concepts

- An **event** is an immutable fact about one owner, with a registered kind, a
  source, a trust level and a stable id. RFC 0002's `ShipEvent` is the subset
  addressed to the Ship; this RFC widens the producer side, not the queue.
- A **source** is where events come from: `kernel` (built-in kinds), `clock`,
  `webhook:<id>` (a person-made endpoint), or `mcp:<serverId>` (an MCP server's
  event subscription).
- A **rule** maps events to outcomes. Each built-in kind has a default rule; a
  person or their Ship can change it.
- A **notice** is one rendered, deterministic message to the person on one
  channel. The existing `owner_notices` table and runtime become the notify
  outcome's delivery path for every kind.

## Policy

```ts
type NoticeRule = {
  ruleId: string;
  match: {
    source: string;               // "kernel", "webhook:wh_…", "mcp:mcp-…", or "*"
    kind?: string;                // e.g. "mail.received", "github.push"
    where?: FieldTest[];          // equality / prefix tests on declared payload fields only
  };
  notify: "none" | "messenger" | "everywhere";   // everywhere = messenger + OS notifications
  ship: "none" | "context" | "wake";
  quiet?: { from: string; to: string };          // local time; notify waits, ship outcome doesn't
  createdBy: "default" | "person" | "ship";
};
```

- Rules are per owner and evaluated in order; the first match wins. Defaults sit
  last and cannot be deleted, only overridden.
- `where` can test only fields the source **declares** (a webhook source's
  mapped fields, an MCP event type's `payloadSchema`). Rules never run code or
  inference, so a payload cannot talk its way past a rule.
- The person edits rules in Settings → Notifications. The Ship edits them with
  `notify.rule.*` syscalls under a capability the Ship has by default. A Ship
  change to a rule that adds `wake` for an outside source is reported to the
  person as a notice, so a prompt-injected Ship cannot quietly wire itself up.
- "Let my Ship decide" is a rule outcome, not a separate mechanism:
  `{ notify: "none", ship: "wake" }`. The Ship then notifies by sending a message
  as it does today.

### Defaults

| Kind | Notify | Ship |
|---|---|---|
| `contact.request`, `contact.invite.accepted` | messenger | context |
| `contact.message` (person-handled) | messenger | context |
| `contact.message` (Ship-handled) | none | wake |
| `hil.requested` on a run with no active client | messenger (adapter renders buttons, as today) | — |
| `mail.received` | messenger, batched per 10 min | wake (as today) |
| `r12y.blocked_on_owner`, `r12y.overdue` | messenger | context |
| `target.paired` | messenger | context |
| `channel.broken` | the other channel (see Delivery) | context |
| `webhook:*`, `mcp:*` | messenger | none |

Outside sources default to **notify only**. Waking the Ship on an untrusted
payload is something the person opts into per source.

## Delivery

The notify outcome reuses the phase 1 runtime:

```text
event ─► rule.notify ≠ none
          └─► owner_notices row (key = coalescing key, e.g. "mail:<owner>" per 10 min)
                └─► OwnerNoticeRuntime
                      ├─ admit: still true? (read, decided, muted, resolved → drop)
                      ├─ active client? → the client shows it; mark dismissed
                      ├─ messenger: adapters.privateDestinations → adapter.send
                      └─ OS: Desktop notification / Web Push (step 6)
```

- `owner_notices.topic` stops being a CHECK-constrained list of three and becomes
  the event kind, with a registered renderer per kind (`owner-notice-text.ts`
  already holds the en/es/pt-BR templates). Outside sources render
  `"<source label>: <title field>"`, where the person picks the title field when
  they create the source; with none, `"New event from <source label>"`.
- **A broken channel is announced elsewhere.** `channel.broken` for WhatsApp goes
  to the next private destination (another messenger, then OS notifications);
  with none, it waits for the next active client.
- Approvals keep their adapter rendering: the adapter already owns HIL buttons.
  The change is that `hil.requested` passes through the same rule and active-
  client check, so a person on the web app is not also pinged on WhatsApp.
- The `attention` flag on `message.committed` (one consumer, `useTabAttention`)
  becomes the client-side rendering of an `unread` notice and is deleted.

## Event sources from outside

### One receiver per Ship

```text
POST https://<handle>.ship.space/hooks/<sourceId>
  Gateway: hostname → installation (directory, as for every request)
           size ≤ 256 KiB, else 413
  Kernel:  source exists and is enabled          else 404 (410 once deleted)
           rate limit per source (token bucket)  else 429 + retry-after
           verify signature over the raw bytes   else 401
           dedupe on (sourceId, eventId)         duplicate → 200
           persist event, then 2xx               ← only after it is durable
           evaluate rule (async)
```

- **Verification follows Standard Webhooks**: `webhook-id`, `webhook-timestamp`
  (reject > 5 min skew), `webhook-signature` `v1,<base64 HMAC-SHA256>` over
  `id.timestamp.body`, with `whsec_` secrets. GSV generates the secret when the
  person creates a source and shows it once. Rotation keeps the previous secret
  valid for 24 hours.
- **Non-standard senders** (GitHub's `X-Hub-Signature-256`, Stripe's
  `Stripe-Signature`) are verifier presets on the same source type, not separate
  mechanisms. A source with no signing support can use a long random path token
  instead, marked as weaker in the UI.
- Secrets live in Kernel storage beside MCP OAuth credentials, under the same
  protection; HMAC needs the plaintext, so they cannot be hashed. Bodies, secrets and
  signatures are never logged; telemetry records source kind, size, outcome and
  latency.
- The event's `eventId` is the sender's stable id (`webhook-id`, GitHub delivery
  GUID, Stripe event id), so a sender's retries deduplicate.
- The body is stored as untrusted JSON. Fields the source maps (title, kind,
  `where` fields) are extracted at ingress; the Ship sees the full body only
  through a resource reference, framed as untrusted.

### MCP Events (SEP-3415)

SEP-3415 lets an MCP server offer event types (`events/list`) that a client
receives by polling (`events/poll`), a long-lived stream (`events/stream`), or a
webhook subscription (`events/subscribe`) signed with Standard Webhooks. GSV is
already an MCP client for every server a person connects, so those servers become
event sources with no new connection:

```text
connect MCP server ─► initialize; capabilities.extensions["io.modelcontextprotocol/events"]?
                    └─► events/list → event types (name, inputSchema, payloadSchema, delivery[])
person or Ship: "tell me when <event type> with <arguments>"
  └─► Kernel creates source mcp:<serverId>:<subscriptionKey>
        webhook offered → events/subscribe { name, arguments,
                            delivery: { mode: "webhook",
                                        url: https://<handle>.ship.space/hooks/<sourceId>,
                                        secret: whsec_… (GSV-generated) },
                            cursor, ttlMs }
                          ← { id, refreshBefore, cursor }
                          Kernel task refreshes before refreshBefore (with cursor)
        poll only       → Kernel task calls events/poll at max(nextPollMs, 60 s)
        stream only     → not supported (see below)
```

- **Webhook first.** It costs nothing between events: no open connection, no
  timer, one request per event through the receiver above. The receiver is the
  same one person-made sources use, so verification, dedupe, rate limits and
  policy are shared code.
- **Receiver consent.** The Gateway serves
  `/.well-known/mcp-webhook-receiver.json` with `{"receivers": ["/hooks/"]}` on
  every Ship hostname, and the receiver answers the subscribe-time challenge
  envelope with its nonce, so either verification mode in the draft works.
- **Control envelopes.** A `gap` envelope (events skipped) becomes a
  `<source>.gap` notice so the person knows the stream is incomplete; a
  `terminated` envelope disables the source and notifies. Neither wakes the Ship.
- **Cursors** are stored per source and sent on every refresh, so a refresh after
  downtime resumes where the source left off, within the server's `maxAgeMs`.
- **No push streams.** `events/stream` needs a connection held open
  indefinitely. In a Durable Object that keeps the Kernel resident and billing
  duration for every subscribed Ship. Servers that only offer `push` are listed
  but cannot be subscribed to until they offer webhook or poll.
- **The draft will change.** The extension id, error codes (`-32023`…`-32027`) and
  secret encoding are provisional. The client sits behind a feature flag,
  isolated in one module (`kernel/mcp-events.ts`), with conformance tests from
  the working group's suite once they merge.

### What the receiver gives a person

The same receiver works for any service that can POST: GitHub, Stripe, Linear,
a home sensor, a form, IFTTT or Zapier. Combined with rules that only notify,
the Ship becomes the place where everything that wants a person's attention
arrives, and only what they choose reaches them or wakes the Ship.

## Clock events

`r12y` stores `dueAtMs`, and RFC 0002 step 6 turns due times into `r12y.due`
events. This RFC adds the person-facing side:

- `r12y.overdue`: a responsibility assigned to the person (blocked on them) has
  passed its due time. Fires once per due time.
- `r12y.blocked_on_owner`: a responsibility moved to waiting on the person.
  Coalesced per owner per hour.

## Cost and scale

| Path | Per event | Idle cost |
|---|---|---|
| Kernel producer | one `owner_notices` row; one adapter request when it notifies | none |
| Webhook / MCP webhook | one Gateway request, one Kernel request, one SQLite write | none |
| MCP poll | one outbound request per interval | one alarm per interval per source |
| MCP refresh | one outbound request per lease (typically hours) | one alarm per lease |

- Rate limits are per source (default 60 events/min, burst 120) and per owner
  across sources (default 600/min). Excess returns 429, which Standard Webhooks
  senders retry.
- Coalescing keys bound notices: a source that sends 500 events in a minute
  yields one notice ("GitHub: 500 new events"), not 500 messages.
- Event bodies past 64 KiB are stored in R2 under the installation scope and
  referenced; SQLite keeps only the extracted fields.
- Events are kept 30 days, then pruned with their bodies.

## Security

- A source id is an address, not a credential; every delivery must verify.
- Ingress never resolves a Kernel for a hostname the directory doesn't route
  (existing invariant), and an unknown source answers 404 before any body parse.
- A paused or suspended installation answers 503 to the receiver, so senders
  retry later instead of losing events; the gate's existing rules apply.
- Outside payloads are untrusted everywhere they are rendered, and the Ship
  never receives secrets or raw signatures.
- Outbound MCP subscribe calls use the existing MCP connection and its OAuth
  credentials; GSV never sends a person's webhook secret anywhere except to the
  server that will sign with it.

## Implementation steps

Each step is one PR and deletes the path it replaces.

| # | Change | Deletes |
|---|---|---|
| 1 | Event kind registry + `notice_rules` (Kernel migration), defaults equal to phase 1 behaviour; `owner_notices.topic` CHECK dropped | hard-coded topic routing in `OwnerNoticeRuntime` |
| 2 | Settings → Notifications (rules list, per-kind toggles) + `notify.rule.*` syscalls | — |
| 3 | Fold in `mail.received`, `hil.requested`, unread | `attention` on `message.committed`; adapter-only approval delivery when a client is active |
| 4 | `r12y.overdue`, `r12y.blocked_on_owner`, `target.paired`, `channel.broken` (with the other-channel rule) | — |
| 5 | Webhook sources: receiver, Standard Webhooks verifier + GitHub/Stripe presets, source UI, field mapping | — |
| 6 | OS notifications: Desktop native, web Notification + Web Push | — |
| 7 | MCP Events client (flagged): `events/list` on connect, subscribe/refresh/poll, receiver well-known + challenge, gap/terminated handling | — |

Steps 1–4 depend on RFC 0002 only where the Ship outcome is `wake`, which
already goes through `ship_events`. Step 5 does not depend on step 7; step 7
reuses step 5's receiver.

## Invariants

- Every notice is deterministic and comes from a rule; no notice is written by
  inference.
- One receiver, one verification path, one policy for every outside source.
- An outside event is acknowledged only after it is durable, and deduplicated by
  the sender's id.
- An outside source never wakes the Ship unless the person enabled that rule.
- A notice about a channel never depends on that channel.
- Rules match only declared fields; a payload cannot change how it is routed
  except through those fields.

## Open questions

1. **GSV as an MCP Events server.** The same extension would let other agents
   (ChatGPT, Claude) subscribe to a person's Ship: "tell me when my Ship finishes
   a delegation" or "when a contact writes". That is the reverse direction and a
   separate RFC; it is worth deciding whether we want it before step 7 fixes the
   module's shape.
2. **Ship-made rules.** Should a Ship-created rule that wakes it on an outside
   source need the person's approval, rather than only a notice afterwards?
3. **Quiet hours** per rule, or one setting per person?
4. **Mail batching.** Is a 10-minute digest right for mail, or should each
   message notify like contact messages do?
5. **Draft drift.** If SEP-3415 changes the webhook envelope before it is
   accepted, do we ship step 7 against the draft behind the flag, or wait?
