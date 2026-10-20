# RFC 0002: Event Wakes

Status: **proposed**

## Summary

Ship should wake because something happened, not because a ledger row changed.
This RFC makes Ship events the single way work reaches the Ship, and keeps the
responsibility ledger (`r12y`) for what it is good at: what is owed, by when, and
whether a run may yield.

```text
 today                                      proposed

 producer ─► r12y mutation                  producer ─► event (+ r12y change, same txn)
               │ change_pending                            │
               ▼                                           ▼
          ledger wake batch ─► r12y.ready      Kernel ship_events ─► current Ship pid
                                                  ▲
 producer ─► pid-addressed event (own retry)      └── clock: r12y due / check / lease
```

[#466](https://github.com/deathbyknowledge/gsv/pull/466) introduced the queue
(`ship_events`) and its first producer, `contact.message`. This RFC records the end
state and the order in which the remaining producers move over.

## How Ship wakes today

Ship receives work through two unrelated mechanisms.

**Ledger wakes.** Any responsibility mutation not made by Ship sets
`change_pending`. The ledger keeps one scheduled task per owner at the earliest of
five conditions, then sends one `r12y.ready` batch naming the affected records:

```text
responsibilities row
  change_pending = 1    ← another actor changed it            → wake now (≥1 s, coalesced)
  wake_retry_at         ← 5 min after a batch, if unsettled   → wake again
  next_check_at         ← waiting recheck (default 24 h)      → wake then
  due_at                ← deadline                            → wake then
  lease_expires_at      ← delegated lease ran out             → wake then
            │
            └─ MIN(...) ─► onResponsibilityWake ─► r12y.ready batch ─► Ship
```

**Pid-addressed events.** Other sources push a typed event straight into one
Process, and each owns its own retries:

| Source | Path | Retry owner |
|---|---|---|
| Delegated child result | `ipc.reply` / `ipc.timeout` signal to the caller pid | IPC call record |
| Schedule with a reply route | `proc.schedule.deliver` → `schedule.fired` | Scheduler occurrence |
| Work session returned | `adapter.work.returned` | Adapter routing |
| Target connected / disconnected | `proc.event.deliver` → `target.connection` | Target events |
| Watched signal | `signal.watched` | Signal watch |

Eleven Kernel producers mutate the ledger in a way that wakes Ship:

| Producer | Responsibility | Also sends an event? |
|---|---|---|
| Delegation return (`ipc-runtime`) | reassigns the record to Ship | yes: `ipc.reply` (double wake) |
| Schedule `--ship` (`schedule-runtime`) | `schedule.due` per occurrence | no |
| Mail (`mailbox`) | `mail.received` per message | no |
| Contact requests (`federation/requests`, `federation`) | track or close a request | no |
| Contact messages (`federation/attention`) | moved to Ship events by #466 | `contact.message` |
| Machine added, adapter connected / auth required (`lifecycle-responsibilities`) | one per occurrence | target events only |
| Browser handoff ended (`browser-handoff-runtime`) | reopens the work | no |
| Memory review (`memory-review`) | "Update personal memory" | no |
| Onboarding (`onboarding-responsibility`) | "Welcome to Ship" | no |
| Person edits in UI or CLI (`responsibilities`) | any field | no |

## Problems

1. **Messages merge in transit.** The ledger coalesces revisions by design. That is
   right for "this record changed" and wrong for "these three things happened":
   a photo and its caption arrived as one wake naming only the latest.
2. **Double wakes.** A delegation return produces both `ipc.reply` and `r12y.ready`
   for one fact.
3. **Content rides on records.** To tell Ship what happened, producers write
   event content into responsibility details (`contactReply`, mail summaries),
   rewriting the record on every occurrence.
4. **Every source rebuilds delivery.** IPC calls, scheduler occurrences, wake
   batches and target events each have their own retry, dedupe and recovery code.
5. **Pid addressing.** Ship's pid is replaceable. A pid-addressed event has to
   work out where Ship went; a Ship-addressed one does not.
6. **No way in from outside.** A future per-Ship webhook cannot become eleven
   ledger producers. It needs one durable, deduplicated entry point.

## Proposal

### Concepts

- An **event** is an immutable fact addressed to the Ship: it happened once,
  carries its own content or references, and is delivered once.
- A **responsibility** is unresolved work: what is owed, to whom, and by when.
  It changes rarely and never carries per-occurrence content.
- The **Ship event queue** (`ship_events`) is the only path by which the Kernel
  wakes the Ship or tells it something happened.

### Event record

```ts
type ShipEvent = {
  eventId: string;                 // stable, producer-chosen: replays dedupe
  ownerUid: number;
  kind: ShipEventKind;             // registered, typed payload per kind
  payload: ShipEventPayload;
  delivery: "wake" | "context";    // start or join a run, or only add context
  trust: "owner" | "untrusted";    // rendering frames untrusted content
  responsibilityIds?: string[];    // records this event concerns; gate yield
  media?: ResourceBlock[];         // retained by Process as its own media
};
```

**Media must outlive the queue.** An event may carry only references whose source
lasts at least as long as the event can wait: an immutable revision in owned
storage, or a grant that lives as long as the relationship that issued it. A
producer holding temporary media retains the exact revision into Ship-owned
storage before committing the event, as a Process retains a source before
committing a Message. Contact attachments today rely on the sender's grant; the
planned eager copy at federation admission makes them owned by the receiving Ship
before they are queued.

#466 stores the payload of one kind (`contact.message`). Generalising means a
registry of kinds alongside the existing `procHistoryEventPayloadSchemas`, so the
Kernel queue, the Process admission and the history renderer share one schema per
kind.

### Delivery

```text
producer txn ──► INSERT OR IGNORE ship_events(eventId, ...)    ← dedupe by eventId
      │          (+ r12y create/update marked announced)
      ▼
queueShipEvents(owner) ─► onShipEvents(owner)
                             for each event, oldest first:
                               ensure the personal controller (current Ship pid)
                               proc.runtime.event.deliver(eventId, event)
                                 ok   → delete row; stamp recovery on its records
                                 fail → attempt+1, back off, stop (keeps order)
```

- Order is per owner. A failing event blocks later ones, so Ship never sees a
  caption before its photo.
- Process deduplicates by `eventId` using its runtime-event admission records.
  Those records belong to one pid. If an acknowledgement is lost and Ship is
  replaced before the retry, the new pid would admit the event again. The queue
  closes this gap by recording which pid each attempt went to; when a retry
  resolves a different pid, the replacement first receives its predecessor's
  recent admission records, as replacement already carries memory-review
  sources, so the receipt survives the pid. #466 has this gap; closing it is
  part of step 1.
- Account removal and the managed lifecycle gate pause delivery exactly as they
  pause ledger wakes today.
- Recovery on Kernel start reschedules every owner with queued events.

### Wake and context events

Not every event should start a run.

| `delivery` | Ship idle | Ship busy |
|---|---|---|
| `wake` | starts a run | joins the current run |
| `context` | appended to history; seen on the next run | appended; seen on the next turn |

Examples: a contact message wakes. A `--to` reminder that the Kernel sent
directly is context: Ship should know it went out, but needs to do nothing. A
target disconnecting is context unless work depends on it.

### The ledger after this change

```text
r12y ledger
  state        what is owed, assignee, blocker, priority     (unchanged)
  projection   baseline + responsibility.revision events      (unchanged)
  yield gate   a run settles the records its events name      (from events)
  times        due_at, next_check_at, lease_expires_at        (stored here, emitted as events)
  wakes        change_pending, wake batches, r12y.ready       (removed)
```

- **Mutations stop waking.** Every mutation has a cause, and the cause is an event.
  A producer changes the ledger and enqueues its event in one transaction, marking
  the change `announced` (#466). A person editing a record in the UI becomes an
  `r12y.edited` event.
- **Time becomes a source.** The clock reads the ledger's times and emits
  `r12y.due`, `r12y.check` and `r12y.lease_expired` events through the same queue,
  with stable ids (`r12y.due:<id>:<dueAt>`) so a time fires once.
- **Recovery becomes redelivery.** Today a delivered batch sets `wake_retry_at`
  five minutes out. In the end state, an event that names responsibilities is
  not settled until the run that received it settles them; if that run fails, the
  queue emits `r12y.unsettled` for the records still actionable.
- **Yield gating stays.** #466 already gates a run on the responsibility its
  `contact.message` names; every `wake` event that names records does the same.

### Webhooks (later, not in this RFC's scope)

The queue is the entry point a per-Ship webhook needs:

```text
POST https://<handle>.ship.space/_gsv/events/<source>
  ├─ authenticate the source (per-source secret or signature)
  ├─ rate-limit and size-limit the body
  ├─ eventId = source + idempotency key
  └─ enqueue { kind: "webhook", trust: "untrusted", delivery: per-source policy }
```

Defining sources, their authentication and their rendering is a separate RFC.

## Migration

Each step is one PR. It converts one producer and deletes its old wake path.

| # | Producer | Becomes | Deletes |
|---|---|---|---|
| 0 | Contact messages | `contact.message` (wake) | `contactReply` details. **Done in #466.** |
| 1 | Delegation return | `ipc.reply` on the Ship queue, naming the returned record; admission receipts survive Ship replacement | the second `r12y.ready`; the IPC call's own Ship retry |
| 2 | Schedules | `schedule.fired` for `--ship`, reply-route and `--to` targets (wake, wake, context) | the `schedule.due` responsibility per occurrence; Ship-bound `proc.schedule.deliver` (non-Ship targets keep it) |
| 3 | Mail | `mail.received` (wake, untrusted, summary in payload) | summary in responsibility details |
| 4 | Lifecycle, contact requests, browser handoff, memory review, onboarding | one typed event each | their `observedByShip: false` wakes |
| 5 | Person edits | `r12y.edited` (wake) | the remaining `change_pending` callers |
| 6 | Clock | `r12y.due`, `r12y.check`, `r12y.lease_expired` | the due, check and lease clauses of `nextWakeAt` |
| 7 | Recovery | `r12y.unsettled` from the queue | `wake_retry_at` |
| 8 | Direct Ship paths | `adapter.work.returned`, `target.connection` and `signal.watched` on the Ship queue when the target is Ship | their Ship-specific delivery and retry (non-Ship pids keep pid-addressed delivery) |
| 9 | Cleanup | — | `change_pending`, wake batches, `r12y.ready`, `onResponsibilityWake`, `responsibility_wake_batches` (migration) |

After step 9, `ResponsibilityRuntime`'s wake code, the batch table and the
`r12y.ready` runtime event are gone, and every source that addresses the Ship
shares one delivery path. Events between other Processes, such as a child's IPC
result to a worker parent, stay pid-addressed.

## Invariants

- One queue, one delivery path, one Ship.
- An event is admitted at most once into the Ship's history, across Ship
  replacement, and is retried until admitted.
- An event's media outlives the event's time in the queue.
- Events from one owner reach Ship in the order their producers committed them.
- A producer's ledger change and its event commit together or not at all.
- The ledger never wakes Ship on its own; only events do.
- A run woken for responsibilities cannot yield until they are settled.
- Untrusted content is framed as untrusted wherever it is rendered.

## Open questions

1. **Context events and the model.** Should a `context` event appear in the next
   run as its own `[GSV EVENT]`, or be folded into a short "while you were away"
   digest when several accumulate?
2. **One failing event blocking the queue.** Strict order is right for one
   conversation. Should order be per source (per contact, per mailbox) so a broken
   delivery from one cannot hold up the others?
3. **Delegated children.** Child Processes receive events today only through IPC.
   Do they get their own queue, or does the Ship queue stay Ship-only?
4. **Retention.** Delivered rows are deleted. Is a short delivered-event log worth
   keeping for inspection (`proc events`), or is Process history enough?
5. **Webhook policy.** Which sources may `wake` rather than only add `context`, and
   who decides: the owner per source, or the operator?

## Non-goals

- Changing how the responsibility ledger is projected into Process context.
- Changing user-message admission. Messages from the owner stay ordinary
  conversation input.
- A general publish/subscribe bus between Processes.
