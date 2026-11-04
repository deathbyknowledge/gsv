# Events: one log, one runner

Status: reviewed 2026-11-03; the decisions are folded in and listed under
Decided. Typed internal calls (#645) are merged into `refactor/event-log`. The
substrate is in #646, an open draft, where producers convert one commit at a
time: contact messages, owner notices, responsibility wakes, schedules, source
events, IPC, target connections, memory reviews, chat, direct `proc.send`,
spawn prompts, messengers and `/ship` work returns so far.

## Problem

New work reaches a process along 16 paths, all listed under Fit: producers.
Each path picks its own storage, dedupe, retry, gate behaviour and busy-run
rule.

```text
today
  chat ─────────────────────────────── inline ──────────────▶ proc.send ─────────────▶ interrupt
  messenger ─── ingress receipts ────── inline ──────────────▶ proc.adapter.deliver ──▶ interrupt
  IPC ───────── ipc_calls ───────────── inline ──────────────▶ proc.ipc.deliver ──────▶ own run after
  contact ───── federation_inbox ─▶ ship_events ─▶ onShipEvents ─▶ proc.runtime.event.deliver ─▶ join
  notice ────── owner_notices ─────────────────▶ onOwnerNotices ─▶ proc.event.deliver ─▶ join or record
  mail, hook, Ship schedule, memory review, welcome
                ─▶ r12y ledger ──────▶ onResponsibilityWake ─▶ r12y.ready ───────────▶ join
  pid schedule ──────────────────────────────▶ onScheduleDue ─▶ proc.schedule.deliver ─▶ join or own run
  target status ─ signal_watches ── in memory, no retry ────▶ proc.event.deliver ────▶ join
  failed delivery ──────────────────▶ onProcessDeliveryNotice ─▶ proc.delivery.notice ─▶ record
```

What that costs:

- Retry follows eleven different rules (see Kernel tasks). One of them is
  pasted into three runtimes.
- "One pending task per owner, moved earlier when something is due sooner" is
  written five times.
- When the gate is closed, a source rechecks in 60 s, refuses, drops, skips
  the check, or relies on the Process tick gate.
- The Ship's pid is found four ways: `ensurePersonalController`,
  `conversation.handlerPid`, `isPersonalController` and surface routes.
- Dedupe lives in six Kernel mechanisms, plus capped receipts in Process
  storage (512 runtime events, 256 IPC). A replacement Ship has none of them.
- Reset fences only IPC signals and `target.status`.
- On some paths two retry layers stack: the callback's own re-queue, and the
  scheduler's retry of a callback that throws. The scheduler waits between
  attempts inside the alarm (`shared/durable-tasks.ts:177`), so a delivery
  notice that keeps failing holds the Kernel awake for about 2.5 minutes of
  billed wall-clock.

## Model

```text
after
  producer, in its own transaction:
      domain write  +  append event
            │
            ▼
  events        one row per event; a repeated (type, key) appends nothing
            │   the type's registry entry names its consumers
            ▼
  deliveries    one row per event and consumer: lane, attempts, next attempt, outcome
            │
            ▼
  runner        one task, one retry rule per consumer, one gate check
            ├─▶ personal:<uid>   the Ship, whatever its pid   deliverEvent
            └─▶ proc:<pid>       one process                  deliverEvent
```

Outboxes keep their own tasks: adapter route sends, the federation outbox,
outbound mail and the owner's messenger notices. Each may append an event in
the transaction that records its outcome (see Chained events).

An event:

```ts
type KernelEvent = {
  seq: number;          // log order
  id: string;           // "evt_" + seq: stable and never reused
  type: EventType;      // registered, e.g. "contact.message"
  ownerUid: number;     // whose event: visibility and the Ship's lanes
  subject: string;      // what it is about: "contact:<id>", "proc:<pid>", "schedule:<id>"
  actor: EventActor;    // who caused it: person, process, contact, schedule, source, kernel
  key: string;          // the producer's idempotency key
  body?: EventBody;     // JSON up to 64 KiB inline, or a reference the producer's store owns
  createdAt: number;
};
```

`workers/gateway/src/kernel/events/registry.ts` lists the types. Each
definition sits beside the producer that appends it, and the history payload
schemas stay in `@humansandmachines/gsv/protocol`.

```ts
export const contactMessageEvent: EventDefinition<ContactMessageContent> = {
  // Read once, at append: each consumer and the lane that orders it there.
  routes: (event) => [{ consumer: shipConsumer(event.ownerUid), lane: "background" }],
  // Read before each attempt and again after its last await; a reason withdraws it.
  withdrawal: (event, ctx) => …,  // a block, a changed relationship, work Ship no longer has
  // Reads what the delivery needs from the store that holds it, before the Ship is found.
  prepare: async (event, ctx) => …,  // the message, from its Conversation
  // What the Process records, whether it starts or joins a run (see Busy Ship),
  // and the responsibilities it hands that run. It may rebind state: the call follows at once.
  admit: (event, message, ctx) => ({ event, admission: { idle: "start", busy: "join" }, responsibilities, attachments }),
};
```

Tables, as v091 creates them:

```sql
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused, so "evt_" + seq stays unique
  type TEXT NOT NULL,
  owner_uid INTEGER NOT NULL,
  subject TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (type, idempotency_key)
);
CREATE INDEX events_created ON events (created_at);

CREATE TABLE deliveries (
  seq INTEGER NOT NULL REFERENCES events (seq) ON DELETE CASCADE,
  consumer TEXT NOT NULL,          -- "personal:7" or "proc:<pid>"
  lane TEXT,                       -- order within the consumer; NULL goes whenever due
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'withdrawn', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  run_id TEXT,                     -- the run that received it, for Ship deliveries
  outcome_json TEXT,               -- e.g. { pid, queued }
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (seq, consumer)
);
CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE state = 'pending';
CREATE INDEX deliveries_lane ON deliveries (consumer, lane, seq)
  WHERE state = 'pending' AND lane IS NOT NULL;
```

The runner:

```ts
// One pass per onEvents task; a pass that is already running re-arms when it ends,
// and one that throws re-arms a minute later.
private async pass(taskId: string): Promise<void> {
  const gate = await this.host.onboarding.managedWorkGate();
  if (!gate.allowed) return await this.arm(Date.now() + MANAGED_LIFECYCLE_RECHECK_MS, taskId);
  this.pruneWhenDue(Date.now());   // at most hourly, once something is due
  // The oldest due row of each lane, plus every due unlaned row. Lanes run
  // concurrently; each drains one row at a time, in order, and waits while
  // its head backs off. An attempt ends withdrawn (no call), delivered, or
  // failed with its next attempt time. Every lane ends before the pass does.
  const drained = await Promise.allSettled(this.host.events.dueHeads(Date.now()).map((head) => this.drain(head)));
  const failure = drained.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
  await this.arm(this.nextRunAt(), taskId);   // one task, moved earlier when needed
}
```

## Delivery rules

- **Atomic append.** A producer appends in the same `transactionSync` as its
  domain write. The state never changes without its event, and an event never
  exists without its state. The runner is kicked after commit and re-arms
  from `deliveries` on start-up.
- **Inline first.** A producer on a request path (chat, messengers, `proc.send`,
  IPC) asks the runner to deliver its row in the same call, so latency stays
  where it is today. The task only carries retries. When the consumer can't
  take the row right now, the call still succeeds with `queued: true`.
- **Lanes.** A lane is the order key within one consumer, and every consumer
  has two. `person` carries a person's messages: chat, messengers, and a
  person's `proc.send` or spawn prompt. `background` carries everything else,
  in order. A person's message never waits behind background events, for the
  Ship or any other process. A wake batch has no lane: only one waits per
  owner, and a contact message or notice that keeps failing never holds the
  ledger's wakes.
- **At least once.** A delivery is done when its consumer answers. A lost
  answer redelivers, so the Process still dedupes by the delivery's id,
  `evt_<seq>:<consumer>`, which is now stable. A replacement Ship never receives an event the Kernel already marked
  delivered. Only a delivery in flight during the replacement can reach the
  new pid, and that pid has no earlier copy.
- **Withdrawal.** Before each attempt, the runner reads the current state: a
  gone pid for every delivery, a removed account for one not yet attempted,
  then the type's `withdrawal`: a blocked contact, a read notice, a deleted
  schedule. A withdrawn delivery ends as `withdrawn` without a Process call.
  This one rule replaces six ways of handling a killed pid. The runner checks
  again after its last await, such as finding or starting the Ship, and sends
  synchronously after that check. A delivery with a failed attempt may have
  reached its Process, so a removed account doesn't withdraw it: it retries
  until it ends, and the Process dedupes it. A producer can also withdraw its
  own pending deliveries: taking a contact back from Ship withdraws that
  contact's messages still queued for it. A delivery its Process answered is
  recorded delivered even if its producer withdrew it while the call was out.
- **Failed runs.** A delivery can hand its run responsibilities, as a contact
  message hands Ship the work it belongs to. The runner marks them delivered
  in the transaction that ends the delivery, which arms the ledger's recovery
  wakes: 5 m, 15 m, 1 h, then every 6 h while the work still needs action.
  They cover a run that fails or never starts, so nothing in the log
  redelivers.
- **Retry.** The delay is `min(cap, base × 2^(attempt − 1))`. Each consumer
  declares its base, cap, attempt limit and terminal action. Ship and process
  deliveries retry from 2 s, doubling to 256 s, without a limit. The runner
  re-arms; it never waits inside the alarm. A Process that refuses a delivery,
  as when a message's media can no longer be read, ends it as `failed` at once:
  a retry would be refused the same way.
- **Gate.** While the managed gate is closed, the runner parks both consumers
  and checks again in 60 s, and the wake timer takes nothing from the ledger.
  Everything resumes if the space is reactivated.
  Edge producers already refuse before appending. The outboxes keep their own
  rules: the federation outbox parks for 60 s, outbound mail fails for a
  retained, deleting or deleted installation and skips other inactive states,
  and adapter route delivery has no gate.
- **Bodies.** An event carries up to 64 KiB of serialized JSON inline. A
  source event's limit covers its title, preview and body as stored, and a
  webhook payload that doesn't fit leaves its event without it. Anything
  larger stays in the store that accepted it:
  Conversation, mailbox, federation inbox or R2 media. The event carries an
  immutable reference. It never owns bytes; the accepting store still owns
  cleanup.
- **Correlated answers.** A reply, timeout or status answer carries the history
  epoch of the request it answers. After `proc.reset`, the Process drops
  answers from an earlier epoch. New input is never fenced: a contact message
  queued before a reset still reaches the reset Ship.
- **Chained events.** An outbox may append an event in the transaction that
  records its outcome. A notice round the messenger accepted, or left to a
  client, appends `owner.notified` for the Ship. An adapter delivery out of
  attempts appends `delivery.failed` for its pid.
- **Retention.** Deliveries keep their outcome for inspection. A settled
  event keeps its body and outcomes in SQLite for 30 days; an event with a
  pending delivery keeps both. Retention runs once something falls due, at
  most hourly: the runner reads the next due time from the log at start-up
  and after each run, and an append or a settle only brings it forward. A
  producer's kick arms the runner for whatever is due next, so an event that
  goes to no one, such as a source event, still meets its retention. The row
  then keeps only its type and key until
  day 180, so a duplicate that arrives late, such as a resent mail or
  webhook, still appends nothing. A key is about 100 bytes; an event can
  carry 64 KiB. The log stays Kernel-internal until a later owner- or
  root-scoped list syscall, which brings the R2 archive with it; a source's
  listing is its first owner-scoped read. v096 adds the indexes that listing
  and the owner's rate limit read, by type with subject or owner, and a
  source's removal deletes its events.

Not converted: answers inside a run (`proc.hil`, tool `res` frames, the tick,
queue promotion). They resume work that was already admitted; none of them is
new work.

## Busy Ship

What an event does when it reaches a process is declared once per type.
Today each entry handler decides for itself.

| Event | Idle | Busy | Today |
|---|---|---|---|
| `message.received`: chat, messenger, or a person's `proc.send` or spawn prompt | start | interrupt the run | `proc.send`, `proc.adapter.deliver` |
| `process.message`: `proc.send` or a spawn prompt from a process or schedule | start | own run after | `admitQueuedSend` |
| `ipc.message`, `ipc.call` | start | own run after | `proc.ipc.deliver` |
| `work.returned` | start | own run after | `adapter.work.returned` with `distinctRun` |
| `contact.message` | start | join | `proc.runtime.event.deliver` |
| `responsibility.ready`: a batch of up to 25 records | start | join | `r12y.ready` |
| `schedule.fired` | start | join; own run after with `replyTo` | `proc.schedule.deliver` |
| `target.status` | start, or record when only the person sees it | join | `proc.event.deliver` |
| `owner.notified` | record | join | `proc.event.deliver` |
| `delivery.failed` | record | record | `proc.delivery.notice` |
| `ipc.reply`, `ipc.timeout`, `ipc.overdue` | start | join the run that asked; own run after for another run | signals |

Mail and source events have no row: a wake is a responsibility, which
arrives as `responsibility.ready`, and a notice reaches the Ship as
`owner.notified`, its note of what the person was told.

One Kernel → Process call replaces the seven calls and the IPC answer signals
in the last column: the typed Durable Object method `deliverEvent(delivery)`,
not a frame (see Frames and RPC). The public syscalls stay. Its admission
applies the declared policy, which is the first cut of the Process admission
state machine.

## Fit: producers

| Producer | Event | Subject | Key | Body | Consumer · busy | Deleted once converted |
|---|---|---|---|---|---|---|
| Contact message | `contact.message`, appended by the inbox's projection beside the responsibility it owes | `contact:<id>` | the Conversation message id, derived from contact, generation and delivery id | ref: Conversation message | Ship · join | `ship_events`, `onShipEvents`, `ship-event-runtime.ts`, the contact branch of `proc.runtime.event.deliver`; the inbox keeps its own intake and `onFederationInbox` |
| Owner notice | `owner.notified`, appended when a round is sent or left to a client | `notice:<round id>` | round id | inline | Ship · record or join | Ship's half of `ship_events`; `onOwnerNotices` still sends to the messenger |
| Responsibility wake | `responsibility.ready`, appended by the wake timer for a batch of up to 25 records; none while one is still pending, so bursts merge as today | `owner:<uid>` | a fresh id per batch | inline: record ids and ledger revision | Ship · join | `responsibility_wake_batches`, `onResponsibilityWake`'s delivery, `r12y.ready`; the timer and the ledger's recovery wakes stay |
| Inbound mail | none: a wake is a `mail.received` responsibility, and a notice is a notice | — | — | — | Ship, through `responsibility.ready` and `owner.notified` | nothing of its own; both are on the log since steps 3 and 4 |
| Hook, `event.emit` | `source.event`, kept for the source's list and to refuse a repeat | `source:<id>` | source id + source event id, which is unique only per source | inline: up to 64 KiB with title and preview | none; a wake stays a responsibility and a notice a notice | `event_log` and `onEventUpkeep`'s retention, done in step 6 |
| Schedule | `schedule.fired`; a Ship's schedule stays a `responsibility` target | `schedule:<id>` | schedule id + occurrence: due time, forced run or one-shot | inline: schedule id, pid, due and fire times; the message and data are read from the schedule at delivery | `proc:<pid>` · join, or own run after with `replyTo` | `proc.schedule.deliver` and the fire-time turn of a Ship-pid schedule into a responsibility; the one-shot attempt loop stays for `adapter.send` |
| IPC send, call | `ipc.message`, `ipc.call` | `ipc:<id>`: the exchange, shared by a call's check-ins and its end | a fresh id for a message, the call id for a call | inline: the message and metadata, up to 64 KiB | `proc:<target>` · own run after, inline | `proc.ipc.deliver` |
| IPC answer | `ipc.reply`, `ipc.timeout`, `ipc.overdue` | `ipc:<call id>` | call id; a check-in's adds its count | names the call; the answer is read from the call's row at delivery, so it has no size limit | `proc:<caller>` · join the run that asked, or own run after | the three answer signals, `onIpcCallDelivery` and its retry, the row's delivery claim, the Process's 256-entry list of handled calls |
| Chat | `message.received`, appended after the Conversation's own append | `conversation:<id>` | message id | ref: Conversation message, read at delivery | Ship, or the work's pid · interrupt, inline | `proc.send`'s interaction branch, done in step 9 |
| Direct `proc.send`, spawn prompt | `message.received` from a person, `process.message` from a process or schedule | `proc:<pid>` | a fresh id per send | inline, up to 64 KiB | `proc:<pid>` · interrupt from a person, own run after from a process | the Process's `proc.send` command and its choice by origin, done in step 9 |
| Messenger | `message.received`, appended after the Conversation's own append, with its reply route only when the event is new | `conversation:<id>` | message id, derived from the ingress receipt | ref: Conversation message, read at delivery | Ship, or the routed pid · interrupt, inline | `proc.adapter.deliver` and its Process handler, done in step 9; `adapter_ingress_receipts` stays the messenger's inbox |
| `/ship` work return | `work.returned`, appended with the route it clears | `proc:<work pid>` | ingress receipt id | inline: the work pid and the private message it came in | Ship · own run after, inline; withdrawn once a newer private message follows | the `work_return` checkpoint and `proc.runtime.event.deliver`, done in step 9 |
| Memory review | none: the queue admits a low-priority Ship responsibility, `memory.review:<pid>:<segment>`, which Ship delegates to Crew | — | — | — | Ship, through `responsibility.ready` | `onMemoryReview`'s 60 s successor: settling a review admits the next in the same transaction, and a Kernel start admits one left waiting, done in step 8 |
| Welcome | none: sign-in, or the owner's first Ship message, creates the welcome responsibility | — | — | — | Ship, through `responsibility.ready` | nothing of its own |
| Target connection | `target.status`, one per watch, since each watch has its own audience | `target:<id>` | transition id + watch id | inline: the watch, its revision and pid, and the change | the watching pid · join, or record when only the person sees it | the in-memory chain, which gains retry; a newer transition withdraws an older one still pending, done in step 8 |
| Failed delivery | `delivery.failed` | `proc:<pid>` | the hash of run, kind, delivery id and state | inline | `proc:<pid>` · record | `onProcessDeliveryNotice` |

Responsibilities stay as state: what is owed and when. A producer that also
appends an event for the work marks its responsibility `announced`, so the
ledger doesn't wake the Ship for it as well. `observedByShip` doesn't stop a
wake: a Ship write that leaves work actionable wakes on purpose, and the
yield gate covers it.

## Fit: outbound

| Today | Event | Consumer, lane | Retry today | Deleted once converted |
|---|---|---|---|---|
| Adapter route delivery, `onAdapterRouteDelivery` | `message.committed` with an adapter route, a HIL prompt or a run failure for the route | `route:<id>`, one lane per chat | its own re-queue ×10, 1 s doubling to 30 s, about 151 s, plus the task retry inside the alarm; an ambiguous send ends without retry | `onAdapterRouteDelivery`, retry payloads in task rows |
| Client `message.committed` signal | the same event | live: connections at commit, no row | none; clients resync by sequence | nothing; it stays live |
| Federation outbox, `onFederationDelivery` | `contact.send`, a request, its update or a revocation | `contact:<id>`, one lane per contact | ×12, 2 s doubling to 2048 s, about 68 min, plus the task retry inside the alarm; ends at 7 days, on a 4xx other than 408 or 429, a takedown or a gone Ship | its attempt columns and task, though `contact.delivery.list` and `contact.delivery.retry` expose them; the outbox keeps the payload and signs a fresh service-auth token each attempt |
| Outbound mail, `onManagedOutboundEnqueue` | `mail.send` | `mail:<uid>` | 5 s→1 h, no limit, republishing until the mail service completes it, plus the task retry inside the alarm | its task; `mail_outbound` keeps staging and Queue claims; Queue acceptance isn't completion |

The outbound side converts last. If a conversion doesn't shrink its owner's
state machine, that consumer stays as it is.

## Kernel tasks

| Task | Retry today | Becomes |
|---|---|---|
| `onShipEvents` | 2 s doubling to 256 s, no limit | runner, done in step 3 |
| `onOwnerNotices` | the same formula | stays: it sends to the person's messenger |
| `onResponsibilityWake` | the same formula, plus recovery wakes at 5 m, 15 m, 1 h, then every 6 h, armed at delivery | timer that appends `responsibility.ready`, done in step 4; recovery wakes stay in the ledger |
| `onScheduleDue` | 5 s→5 min, 10 attempts for one-shot | timer that appends `schedule.fired`, done in step 5; one-shot attempts stay for `adapter.send` |
| `onIpcCallTimeout` | default task retry: 3 attempts, in-alarm | timer that appends `ipc.timeout` or a check-in, done in step 7 |
| `onIpcCallDelivery` | re-queue every 5 s, no limit, plus in-alarm 1 s→30 s ×10 | runner, done in step 7 |
| `onProcessDeliveryNotice` | in-alarm 1 s→30 s ×10 | runner |
| `onAdapterRouteDelivery` | ×10 1 s→30 s, plus in-alarm ×10 | stays: the adapter route outbox |
| `onFederationDelivery` | ×12 2 s→2048 s, plus in-alarm retry | stays: the federation outbox |
| `onFederationInbox` | fixed 30 s | stays: the inbox's own intake |
| `onManagedOutboundEnqueue` | 5 s→1 h, republishing until completion, plus in-alarm retry | stays: the outbound mail outbox |
| `onMemoryReview` | fixed 60 s successor | delete: settling a review admits the next, done in step 8 |
| `onEventUpkeep` | none | timer for silent sources; its retention moved to the log in step 6 |
| `onProcessApprovalNotice` | none: it already returns at once | delete, done in step 2 |
| `onRouteExpired` | none | stays: request route expiry |
| `onLedgerRotate` | none | stays: syscall ledger rotation |
| `onBrowserHandoffs` | none | stays: handoff reconciliation |
| `onApproachMaintenance` | gate recheck 60 s | stays: contact request upkeep |

That leaves 14 task kinds instead of 18: the runner, 4 timers, 4 outboxes,
the federation inbox and 4 housekeeping tasks. Timers append events; they
never deliver.

## Frames and RPC

Kernel and Process already call each other over Durable Object RPC; each
side's `recvFrame` takes frame objects, not JSON. Frames stay where they earn
their keep:

- **The edge.** Clients, machines, the browser extension and adapters speak
  the protocol, and their frames are validated where they arrive.
- **Routed syscalls.** When the Kernel passes a public syscall to its
  implementer, a device or a Process, it forwards the frame. Authorization,
  the ledger and cancellation follow one path, and an answer that arrives
  minutes later, after eviction, still matches by frame id. An RPC promise
  does not survive eviction.

Ten internal calls ride `recvFrame` as if they were syscalls, each with a
made-up id, a `res` wrapper and a branch in an `if (frame.call === …)` chain.
They become typed Durable Object methods, or go away with their producer:

| Call | Direction | Becomes |
|---|---|---|
| `proc.event.deliver` | Kernel → Process | `deliverEvent(delivery)` |
| `proc.tool.authorize` | Kernel → Process | a typed method |
| `proc.resources.retain` | Kernel → Process | a typed method |
| `proc.resource.write` | Kernel → Process | a typed method; the bytes stay a stream |
| `proc.run.attach`, `proc.run.staged` | gsv shell `message` → Process | typed methods |
| `proc.message.commit` | Process → Kernel | a typed method |
| `proc.runtime.event.deliver` | Kernel → Process | loses contact messages to `deliverEvent`; deleted with responsibility wakes and work returns, done in step 9 |
| `proc.schedule.deliver` | Kernel → Process | deleted with schedules |
| `proc.adapter.deliver` | Kernel → Process | deleted with messengers, done in step 9 |

The calls that wait, `proc.tool.authorize` and `proc.resources.retain`, keep
a request id so the Kernel can still cancel them.

Typed calls add no validation. Kernel and Process ship in one Worker and
deploy together, so their TypeScript types are the contract. Validation stays
where input is untrusted: wire and adapter frames, and syscall arguments,
which come from the model.

## Naming

`event_log` already exists: v090's custom event sources (hooks and
`event.emit`). It has a listing the person sees, 64 KiB bodies kept 30 days,
ids kept 180 days, a rate bucket and `onEventUpkeep`. It is a small version of
this log.

It folds in, done in step 6. Source events are `source.event` rows, a
source's listing reads the log by subject `source:<id>`, and its retention is
the log's, so the listing shows 30 days instead of 180. `event_log` is gone;
`onEventUpkeep` stays for silent sources. The new tables are `events` and
`deliveries`.

`ship_events` goes away with contact messages and owner notices. The internal
`proc.event.deliver` call becomes `deliverEvent`, the one Process entry for
events.

## Order of work

Steps 1 and 2 are their own PRs. From step 3, each conversion is a commit on
the substrate's PR, with failing-first tests and the numbers below, and deletes
the path it replaces. The PR merges once a census test fires every producer on
a clean instance and finds each in the log. Each conversion narrows the
`KernelContext` its module receives.

1. Typed internal calls: the seven calls under Frames and RPC become Durable
   Object methods. No behaviour changes.
2. Substrate: `events`, `deliveries`, the registry, the runner, and
   `deliverEvent` with declared admission. No producer is converted.
   Deletes `onProcessApprovalNotice`.
3. Contact messages and Ship's record of owner notices. Deletes
   `ship_events`, `onShipEvents` and the contact branch of
   `proc.runtime.event.deliver`.
4. Responsibility wakes and the welcome. r12y goes back to being state.
   Deletes wake batches and `r12y.ready`.
5. Schedules. Deletes `proc.schedule.deliver`.
6. Mail and hooks. `event_log` folds in; mail is already on the log through
   its responsibility and its notice.
7. IPC. Deletes `proc.ipc.deliver`, the three answer signals and
   `onIpcCallDelivery`.
8. Target connections and memory reviews. Deletes the in-memory chain and
   `onMemoryReview`.
9. Chat, direct `proc.send`, spawn prompts, messengers and `/ship` work
   returns: inline, on the person lane. Deletes the Process's `proc.send`
   command, `proc.adapter.deliver` and `proc.runtime.event.deliver`.
10. Failed deliveries. Deletes `onProcessDeliveryNotice`.
11. Outbound, only where moving it makes its owner smaller: adapter routes,
    the federation outbox and outbound mail.

## Measures

Before and after each step, on a clean instance:

- **Deliveries per message:** Kernel → Process calls per inbound message, by
  source. A hook that both wakes and notifies costs 2: the wake, and the
  note of what the person was told.
- **Accounts calls per message:** directory lookups per inbound message. #642
  already cut adapter and mail calls to one per installation per minute.
- **Kernel CPU per turn:** Kernel CPU ms per Ship turn, from the clean-instance
  tail.
- **Kernel alarms per message:** each alarm is a billed Durable Object
  request.

## Decided

Reviewed with the maintainer on 2026-11-03:

1. **Rows, not cursors.** One delivery row per event and consumer. A cursor
   per consumer would block unrelated subjects behind one failing delivery,
   and per-delivery retry state needs somewhere to live.
2. **Two Ship lanes.** A person's message never waits behind background
   events.
3. **`event_log` folds in.** Two tables named `event_log` and `events` would
   confuse more than the shorter source listing costs.
4. **No outbound exception during a restriction.** The gate pauses outbound
   with everything else; a restriction while a delivery is in retry is rare.
   Since 8, the outboxes stay out of the log and keep their own gate rules
   (see Gate).
5. **Retention.** 30 days in SQLite, then R2; keys for 180 days. Inspection
   comes with a later list syscall.
6. **Frames stay at the edge and for routed syscalls.** Internal calls become
   typed methods.
7. **Settled while building the substrate.** Event ids are `evt_<seq>`, not
   a hash of type and key: the unique type and key already refuse a
   duplicate, and a seq is never reused, even after its key expires. The R2
   archive comes with the list syscall that reads it.
8. **Settled while converting contact messages.** Recovery after a failed run
   stays with the ledger: a delivery marks the responsibilities it hands its
   run, which arms the recovery wakes. The log has two consumers, the Ship and
   a process. Adapter routes, the federation outbox, outbound mail and owner
   notices to the messenger keep their own outboxes; one moves only if moving
   it makes its owner smaller.
9. **Settled while converting responsibility wakes.** A batch drops records
   settled after it was taken, and one with nothing left is withdrawn before a
   Ship is found. A definition's `settled` runs once its delivery ends, so the
   wake timer re-arms for work that came due meanwhile. The timer records each
   record's recovery step when it takes it, and the delivery arms the wake from
   that step; a contact's new message starts it over. The Kernel alarm reads
   due tasks once more before re-arming, so a timer's kick delivers in the same
   alarm. The Process keeps one read, since it checks kill and reset once per
   alarm.
10. **Settled while converting schedules.** A firing names its schedule
    instead of copying the message and data, which have no size limit, so the
    process gets the schedule as it stands. A firing is withdrawn once its
    schedule is removed or goes to another process, or its reply destination
    is no longer allowed. A newer firing replaces one still waiting, so a
    process that can't take firings for a while gets the latest, not a
    backlog. A schedule aimed at a Ship's pid is stored as a `responsibility`;
    v095 converts older rows still aimed at one, and the fire-time fallback is
    gone.
11. **Settled while converting mail and hooks.** Mail needs no event of its
    own: a wake is a `mail.received` responsibility and a notice is a notice,
    and both reach the Ship through the log already. Ship keeps its note of a
    notice even when a wake covers the same mail or hook, so it can answer
    when the person asks about what they were told; the note never starts a
    run. A source's events go to no one: its list and its check for repeats
    read them from the log, which forgets them on its own schedule, so the
    list shows 30 days. An event's 64 KiB covers its title, preview and body
    as stored. `event.emit` refuses a call holding a bigger one before taking
    any of it, and a webhook's event arrives without a payload that doesn't
    fit. v096 moves existing rows and drops `event_log`.
12. **Settled while converting IPC.** A message or call takes a run of its
    own under its delivery's id, `evt_<seq>:proc:<pid>`. When its target
    can't take it right now, the syscall still succeeds with `queued: true`
    and the log retries. A call's deadline counts from the call: one its
    target hasn't received by then is withdrawn, and the caller gets
    `ipc.timeout`. An answer names its call, and the log reads the answer
    from the call's row when it delivers; `settled` removes the row whether
    the delivery went or was withdrawn, so a caller that is gone leaves
    nothing behind. An answer joins the run that asked while that run is
    active, and otherwise waits as a run of its own; it is no longer recorded
    at once beside an unrelated run. One for an aborted run, or made before
    the caller's last reset, is dropped by the Process. A newer check-in
    replaces one still waiting, and the call's end withdraws a waiting
    check-in, since the answer says more. A message and its metadata are
    limited to 64 KiB together; larger content travels as a file path. v097
    moves answers still on their way onto the log, and Process v019 drops
    the list of handled calls.
13. **Settled while converting target connections and memory reviews.** A
    connection change goes to each watch on its target as an event of its
    own, since each watch has its own audience, and now retries. A newer change
    withdraws one still waiting, whichever watch it was for, so a watching
    process hears how the target is now. A change is withdrawn once its watch
    is removed, changed or expired; one that ends withdrawn, as when its
    process is gone or lost its authorization, marks the watch failed. A
    one-time watch ends once its change goes, unless its process ignored it.
    Settling a memory review admits the next one waiting in the same
    transaction, and a Kernel start admits one an older Kernel left waiting;
    v098 removes the per-owner poll.
14. **Settled while converting chat and direct sends.** Every process has a
    `person` lane beside `background`, so a person's message to any process
    never waits behind its background events. A person's message stops the
    run its process is in; one from a process or schedule waits as a run of
    its own. A chat message's event follows its Conversation append, since
    that Durable Object can't share the Kernel's transaction. The message id
    is the key, so a resend after a lost answer appends nothing and redelivers
    what is still waiting, and the text is read from the Conversation at
    delivery, so it has no size limit. Its run stays `run:<message id>`; a
    direct send's run takes its delivery's id, so the reply route is pinned
    before the run starts. When a message's process can't take it right now,
    `conversation.send` and `proc.send` succeed with `queued: true` and the
    log retries. A refusal, as when its media is gone, fails the delivery and
    the send reports the error. A direct `proc.send` or spawn prompt is
    limited to 64 KiB; larger content travels as a file path. The Process
    takes messages only from the log, not as a `proc.send` command.
15. **Settled while converting messengers and work returns.** A messenger
    message is `message.received`, appended after its Conversation append and
    delivered in the ingress call, as chat is. Its reply route is pinned in
    the same transaction as the event, and only when the event is new: an
    adapter's retry after the append may find the run already ended, and a
    second pin would outlive it. A refusal fails the ingress; one its process
    can't take right now answers `queued` and the log retries. The ingress
    receipt stays the messenger's inbox. A `/ship` return is `work.returned`,
    appended with the route it clears and keyed by its receipt, so a retried
    command finds it and answers as the first did. Ship hears it as a run of
    its own after the active one, and it is withdrawn once a newer private
    message follows in that chat. v099 lets a `/ship` an older Kernel left
    checkpointed start afresh.
