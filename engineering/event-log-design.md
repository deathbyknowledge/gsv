# Events: one log, one runner

Status: design for review, 2026-11-03. Branch `refactor/event-log`, stacked on
#642. No code yet.

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

- A source can reach the Ship twice. A hook that both wakes the Ship and
  notifies the person arrives as a responsibility and as `owner.notified`.
  Inbound mail arrives as a `mail.received` responsibility and as a notice.
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
            ├─▶ personal:<uid>   the Ship, whatever its pid   proc.event.deliver
            ├─▶ proc:<pid>       one process                  proc.event.deliver
            ├─▶ inbox:<contact>  a contact's inbound message  Conversation append
            ├─▶ crew:<uid>       memory reviews               Crew Ticket start
            ├─▶ notices:<uid>    the owner's messenger        notice send
            ├─▶ route:<id>       one messenger chat           adapter.send
            ├─▶ contact:<id>     a contact's Ship             federation XRPC
            └─▶ mail:<uid>       outbound mail                the outbound mail Queue
```

An event:

```ts
type KernelEvent = {
  seq: number;          // log order
  id: string;           // stable: "evt_" + hash(type, key)
  type: EventType;      // registered, e.g. "contact.message"
  ownerUid: number;     // whose event: visibility and the Ship's lanes
  subject: string;      // what it is about: "contact:<id>", "proc:<pid>", "schedule:<id>"
  actor: EventActor;    // who caused it: person, process, contact, schedule, source, kernel
  key: string;          // the producer's idempotency key
  body?: EventBody;     // JSON up to 64 KiB inline, or a reference the producer's store owns
  createdAt: number;
};
```

Each type's registry entry sits in `workers/gateway/src/kernel/events/`. The
history payload schemas stay in `@humansandmachines/gsv/protocol`.

```ts
"contact.message": {
  consumers: [ship],            // personal:<ownerUid>
  lane: "background",
  admission: "join",            // see Busy Ship
  admit: contactStillAllowed,   // withdrawn once the contact is blocked or removed
},
```

Tables, sketched:

```sql
CREATE TABLE events (
  seq INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  owner_uid INTEGER NOT NULL,
  subject TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (type, idempotency_key)
);

CREATE TABLE deliveries (
  seq INTEGER NOT NULL REFERENCES events (seq) ON DELETE CASCADE,
  consumer TEXT NOT NULL,          -- "personal:7", "proc:<pid>", "route:<id>"
  lane TEXT NOT NULL,              -- order within the consumer
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
CREATE INDEX deliveries_lane ON deliveries (consumer, lane, seq) WHERE state = 'pending';
```

The runner:

```ts
async onEvents(task: { id: string }): Promise<void> {
  const gate = await this.host.onboarding.managedWorkGate();
  if (!gate.allowed) return await this.arm(Date.now() + MANAGED_LIFECYCLE_RECHECK_MS, task.id);
  // The oldest pending row of each lane; lanes run concurrently, each one at a time.
  await Promise.all(this.deliveries.dueHeads(Date.now()).map(async (head) => {
    const consumer = consumerFor(head.consumer);
    if (consumer.admit(head) === "withdrawn") return this.deliveries.withdraw(head);
    try {
      this.deliveries.delivered(head, await consumer.deliver(head));
    } catch (error) {
      this.deliveries.failed(head, error, retryAt(consumer.retry, head.attemptCount + 1));
    }
  }));
  await this.arm(this.deliveries.nextDueAt(), task.id);   // one task, moved earlier when needed
}
```

## Delivery rules

- **Atomic append.** A producer appends in the same `transactionSync` as its
  domain write. The state never changes without its event, and an event never
  exists without its state. The runner is kicked after commit and re-arms
  from `deliveries` on start-up.
- **Inline first.** A producer on a request path (chat, messengers, IPC) asks
  the runner to deliver its row in the same call, so latency stays where it
  is today. The task only carries retries.
- **Lanes.** A lane is the order key within one consumer. The Ship has two.
  `person` carries chat and messengers. `background` carries everything else,
  in per-owner order as `ship_events` keeps it today. A person's message never
  waits behind background events. Each messenger chat, contact and target
  process is one lane.
- **At least once.** A delivery is done when its consumer answers. A lost
  answer redelivers, so the Process still dedupes by event id, which is now
  stable. A replacement Ship never receives an event the Kernel already marked
  delivered. Only a delivery in flight during the replacement can reach the
  new pid, and that pid has no earlier copy.
- **Withdrawal.** Before each attempt, the consumer's `admit` reads the current
  state: a blocked contact, a read notice, a deleted schedule, a killed pid, a
  disabled account. A withdrawn delivery ends as `withdrawn` without a Process
  call. This one rule replaces six ways of handling a killed pid. As
  `ship_events` does today, a consumer checks admission again after its last
  await and sends synchronously after that check.
- **Failed runs.** Some types declare that their subject needs action:
  `responsibility.due`, `contact.message` and `mail.received`. If the run
  that received one fails, or its pid dies before the run starts, the
  delivery returns to `pending` and is retried at 5 m, 15 m, 1 h and 6 h
  while the subject still needs action. The ledger's recovery wakes move
  here, as agreed on 2026-10-20.
- **Retry.** The delay is `min(cap, base × 2^(attempt − 1))`. Each consumer
  declares its base, cap, attempt limit and terminal action. The runner
  re-arms; it never waits inside the alarm.
- **Gate.** While the managed gate is closed, the runner parks every consumer
  and checks again in 60 s. Edge producers already refuse before appending.
  Open question 4 asks about outbound settlement.
- **Bodies.** An event carries up to 64 KiB of JSON inline, the custom-source
  limit today. Anything larger stays in the store that accepted it:
  Conversation, mailbox, federation inbox or R2 media. The event carries an
  immutable reference. It never owns bytes; the accepting store still owns
  cleanup.
- **Correlated answers.** A reply, timeout or status answer carries the history
  epoch of the request it answers. After `proc.reset`, the Process drops
  answers from an earlier epoch. New input is never fenced: a contact message
  queued before a reset still reaches the reset Ship.
- **Chained events.** A consumer may append the next event in the transaction
  that records its outcome. A notice the messenger accepted appends
  `notice.sent` for the Ship. An adapter delivery out of attempts appends
  `delivery.failed` for its pid.
- **Retention.** Deliveries keep their outcome for inspection. Events stay in
  SQLite for 30 days and then move to R2 segments with their outcomes. Keys
  are kept for 180 days for dedupe, as custom sources keep theirs today.

Not converted: answers inside a run (`proc.hil`, tool `res` frames, the tick,
queue promotion). They resume work that was already admitted; none of them is
new work.

## Busy Ship

What an event does when it reaches a process is declared once per type.
Today each entry handler decides for itself.

| Event | Idle | Busy | Today |
|---|---|---|---|
| `message.received`: chat or messenger | start | interrupt the run | `proc.send`, `proc.adapter.deliver` |
| `process.message`: `proc.send` from a process or schedule | start | own run after | `admitQueuedSend` |
| `ipc.message`, `ipc.call` | start | own run after | `proc.ipc.deliver` |
| `work.returned` | start | own run after | `adapter.work.returned` with `distinctRun` |
| `contact.message` | start | join | `proc.runtime.event.deliver` |
| `responsibility.due` | start | join | `r12y.ready` |
| `mail.received` | start | join | via r12y |
| `source.event`: hook, `event.emit` | start, or record when the source says `context` | join | via r12y or a notice |
| `schedule.fired` | start | join; own run after with `replyTo` | `proc.schedule.deliver` |
| `target.status` | start, or record when only the person sees it | join | `proc.event.deliver` |
| `notice.sent` (now `owner.notified`) | record | join | `proc.event.deliver` |
| `delivery.failed` | record | record | `proc.delivery.notice` |
| `ipc.replied`, `ipc.timed_out`, `ipc.overdue` | settles the call | settles the call | signals |

One Kernel → Process call, `proc.event.deliver`, replaces the seven calls and
the IPC answer signals in the last column. The public syscalls stay. Its
admission applies the declared policy, which is the first cut of the Process
admission state machine.

## Fit: producers

| Producer | Event | Subject | Key | Body | Consumer · busy | Deleted once converted |
|---|---|---|---|---|---|---|
| Contact message | `contact.received`; its projection into the Conversation appends `contact.message` | `contact:<id>` | federation delivery id | ref: `federation_inbox` row | inbox projection, then Ship · join | `ship_events`, `onShipEvents`, `ship-event-runtime.ts`, `onFederationInbox`, the 5-minute redelivery |
| Owner notice | `notice.raised`, then `notice.sent` | `notice:<id>` | notice id | inline | notices, then Ship · record or join | `onOwnerNotices`; the delivery columns of `owner_notices` |
| Responsibility due | `responsibility.due` | `r12y:<id>` | id + due revision | inline | Ship · join | `responsibility_wake_batches`, `wake_retry_at` and `wake_retry_count`, `onResponsibilityWake`, `r12y.ready`, change wakes |
| Inbound mail | `mail.received` | `mail:<id>` | message id | ref: `mail_messages` row | Ship · join; notices when a rule says | the wake through r12y and the parallel notice |
| Hook, `event.emit` | `source.event` | `source:<id>` | source event id | inline | Ship · join or record; notices when the source says | `event_log`, `onEventUpkeep`, the wake through r12y, the double delivery |
| Schedule | `schedule.fired` | `schedule:<id>` | schedule id + fire time | inline | Ship or `proc:<pid>` · join, or own run with `replyTo` | the ledger route for Ship schedules, `proc.schedule.deliver`, the one-shot attempt loop |
| IPC send, call | `ipc.message`, `ipc.call` | `proc:<target>` | call id | inline | `proc:<target>` · own run after | `onIpcCallDelivery` and its in-alarm retry |
| IPC answer | `ipc.replied`, `ipc.timed_out`, `ipc.overdue` | `proc:<caller>` | call id + outcome | inline | `proc:<caller>` · settles | the signal path, the timeout task's delivery |
| Chat | `message.received` | `conversation:<id>` | message id | ref: Conversation message | Ship · interrupt, inline | `proc.send`'s interaction branch |
| Direct `proc.send`, spawn prompt | `message.received` from a person, `process.message` from a process | `proc:<pid>` | the caller's request id; none today | inline | `proc:<pid>` · interrupt from a person, own run after from a process | `handleProcSend`'s choice by origin |
| Messenger | `message.received` | `route:<surface>` | adapter + account + delivery id | ref: Conversation message | routed pid or Ship · interrupt, inline | `proc.adapter.deliver`; `adapter_ingress_receipts` once the key and row cover its checkpoint |
| `/ship` work return | `work.returned` | `proc:<work pid>` | work pid + return id | inline | Ship · own run after | the `work_return` checkpoint, `adapter.work.returned` |
| Memory review | `memory.review.queued` | `owner:<uid>` | source slice id | ref: retained sources | `crew:<uid>` · one open review per owner | KV `memory-reviews:<uid>`, the 60 s successor tasks |
| Welcome | `responsibility.due`, appended with the person's first `message.received` | `r12y:<welcome>` | `onboarding.initial` | none | Ship · join that message's run | nothing: its wake becomes an ordinary responsibility event |
| Target connection | `target.status` | `target:<id>` | target id + observed time | inline | watching pids · join | the in-memory chain, which gains retry |
| Failed delivery | `delivery.failed` | `proc:<pid>` | delivery id | inline | `proc:<pid>` · record | `onProcessDeliveryNotice` |

Responsibilities stay as state: what is owed and when. A producer that also
owes work writes its responsibility with `observedByShip`, so the ledger never
wakes the Ship on its own.

## Fit: outbound

| Today | Event | Consumer, lane | Retry today | Deleted once converted |
|---|---|---|---|---|
| Adapter route delivery, `onAdapterRouteDelivery` | `message.committed` with an adapter route | `route:<id>`, one lane per chat | its own re-queue ×10, 1 s→30 s, plus the task retry inside the alarm | `onAdapterRouteDelivery`, retry payloads in task rows |
| Client `message.committed` signal | the same event | live: connections at commit, no row | none; clients resync by sequence | nothing; it stays live |
| Federation outbox, `onFederationDelivery` | `contact.send` | `contact:<id>`, one lane per contact | ×12, 2 s→1 h | its attempt columns and task; the outbox keeps the signed envelope |
| Outbound mail, `onManagedOutboundEnqueue` | `mail.send` | `mail:<uid>` | 5 s→1 h, no limit | its task; `mail_outbound` keeps staging and Queue claims |

The outbound side converts last. If a conversion doesn't shrink its owner's
state machine, that consumer stays as it is.

## Kernel tasks

| Task | Retry today | Becomes |
|---|---|---|
| `onShipEvents` | 2 s doubling to 256 s, no limit | runner |
| `onOwnerNotices` | the same formula | runner |
| `onResponsibilityWake` | the same formula, plus recovery wakes at 5 m, 15 m, 1 h and 6 h after a failed run | timer that appends `responsibility.due`; recovery moves to deliveries |
| `onScheduleDue` | 5 s→5 min, 10 attempts for one-shot | timer that appends `schedule.fired` |
| `onIpcCallTimeout` | default task retry: 3 attempts, in-alarm | timer that appends `ipc.timed_out` |
| `onIpcCallDelivery` | re-queue every 5 s, no limit, plus in-alarm 1 s→30 s ×10 | runner |
| `onProcessDeliveryNotice` | in-alarm 1 s→30 s ×10 | runner |
| `onAdapterRouteDelivery` | ×10 1 s→30 s, plus in-alarm ×10 | runner |
| `onFederationDelivery` | ×12 2 s→1 h | runner |
| `onFederationInbox` | fixed 30 s | runner |
| `onManagedOutboundEnqueue` | 5 s→1 h | runner |
| `onMemoryReview` | fixed 60 s successor | runner |
| `onEventUpkeep` | none | runner retention |
| `onProcessApprovalNotice` | none: it already returns at once | delete |
| `onRouteExpired` | none | stays: request route expiry |
| `onLedgerRotate` | none | stays: syscall ledger rotation |
| `onBrowserHandoffs` | none | stays: handoff reconciliation |
| `onApproachMaintenance` | gate recheck 60 s | stays: contact request upkeep |

That leaves 8 task kinds instead of 18: the runner, 3 timers and 4
housekeeping tasks. Timers append events; they never deliver.

## Naming

`event_log` already exists: v090's custom event sources (hooks and
`event.emit`). It has a listing the person sees, 64 KiB bodies kept 30 days,
ids kept 180 days, a rate bucket and `onEventUpkeep`. It is a small version of
this log.

Proposal: fold it in. Source events become `source.event` rows, a source's
listing reads the log by subject `source:<id>`, and its retention becomes the
log's. `event_log` and `onEventUpkeep` go away. The new tables are `events`
and `deliveries`.

`ship_events` goes away in step 2. `proc.event.deliver` already exists and
becomes the one Process entry.

## Order of work

Each step is its own stacked PR with failing-first tests, a clean-instance
flow, and the numbers below. Each conversion narrows the `KernelContext` its
module receives.

1. Substrate: `events`, `deliveries`, the registry, the runner, and
   `proc.event.deliver` with declared admission. No producer is converted.
   Deletes `onProcessApprovalNotice`.
2. Contact messages and owner notices. Deletes `ship_events`, `onShipEvents`
   and `onOwnerNotices`.
3. Responsibility wakes. r12y goes back to being state. Deletes wake batches
   and `r12y.ready`.
4. Schedules.
5. Mail and hooks. `event_log` folds in.
6. IPC.
7. Chat and messengers: inline, on the person lane.
8. Outbound: adapter routes, the federation outbox and outbound mail.

## Measures

Before and after each step, on a clean instance:

- **Deliveries per message:** Kernel → Process calls per inbound message, by
  source. A hook that both wakes and notifies costs 2 today.
- **Accounts calls per message:** directory lookups per inbound message. #642
  already cut adapter and mail calls to one per installation per minute.
- **Kernel CPU per turn:** Kernel CPU ms per Ship turn, from the clean-instance
  tail.
- **Kernel alarms per message:** each alarm is a billed Durable Object
  request.

## Open questions

1. **Rows, not cursors.** We discussed subscriptions as (consumer, filter,
   cursor). A cursor per consumer blocks unrelated subjects behind one failing
   delivery, and per-delivery retry state needs somewhere to live. This page
   fans out at append into one delivery row per consumer. The registry plays
   the filter and the lane plays the cursor. OK?
2. **Two Ship lanes.** A person's message never waits behind background
   events, and background events keep per-owner order. OK?
3. **`event_log`.** Fold it into the log, or rename it `source_events` and keep
   it as a producer?
4. **Outbound during a restriction.** Inbound deliveries pause while a Ship is
   restricted. AGENTS.md says "work already admitted may reach its terminal
   boundary." Should messages committed before the restriction still go out
   through adapters, federation and mail?
5. **Retention and inspection.** The proposal: 30 days in SQLite, keys for 180
   days, then R2. The log stays Kernel-internal until a later owner- or
   root-scoped list syscall. OK, or should inspection come in step 1?
