# The Event Log

Every piece of new work that reaches a process, and every reply a run sends to
its messenger chat, goes through one log in Kernel SQLite. A producer appends an
event in the same transaction as its own write. One runner delivers the event to
the process or chat it is for, retries it, and records how the delivery ended.
The log is internal to the Kernel; no syscall reads it.

```text
producer, in its own transaction:
    domain write  +  append event
          │
          ▼
events        one row per event; a repeated (type, key) appends nothing
          │   the type's definition names its consumers
          ▼
deliveries    one row per event and consumer: lane, attempts, next attempt, outcome
          │
          ▼
runner        one durable task, one retry rule per kind of consumer, one gate check
          ├─▶ personal:<uid>   the owner's Ship, whatever its pid
          ├─▶ proc:<pid>       one process
          └─▶ chat:<id>        one messenger chat, named by an opaque id
```

## Events

| Field | Meaning |
|---|---|
| `seq` | Log order. The event's id is `evt_<seq>`, which is never reused. |
| `type` | A registered type, such as `contact.message`. |
| `owner_uid` | Whose event it is. |
| `subject` | What it is about: `contact:<id>`, `proc:<pid>`, `schedule:<id>`. |
| `actor` | Who caused it: a person, a process, a contact, a schedule, a source or the Kernel. |
| `idempotency_key` | The producer's key. A repeat of the same type and key appends nothing and returns the first event. |
| `body` | Up to 64 KiB of JSON, or a reference into the store that owns the content. |

A message's text and media stay in its Conversation, and its delivery reads
them when it goes. The send that commits a message already holds them, so its
own attempt is handed them and only a retry reads them back. A call's answer
travels in its event. The call's row lasts
only while the call is in flight. The files the target's run attached go with
the answer as attachments, and the caller keeps its own copy, the way it keeps
a contact's attachments. An answer too large for its event goes to the caller
as a file in the caller's own home, ahead of them.

A file the caller can't copy is left out and logged, so a file that is gone
can't hold up the deliveries queued behind its answer. A file already in the
caller's own home, such as a long answer's, is only late, so its delivery is
tried again until the file can be read.

## Delivery

`workers/gateway/src/kernel/events/registry.ts` lists the types. Each
definition sits beside the producer that appends it:

```ts
export const contactMessageEvent: EventDefinition<ContactMessageContent> = {
  // Read once, at append: each consumer and the lane that orders it there.
  routes: (event) => [{ consumer: shipConsumer(event.ownerUid), lane: "background" }],
  // Read before each attempt and after its last await; a reason ends it without a call.
  withdrawal: (event, ctx) => …,
  // Reads what the delivery needs from the store that holds it.
  prepare: async (event, ctx) => …,
  // What the process records, whether it starts or joins a run, and the work it hands that run.
  admit: (event, message, ctx) => ({ event, admission: { idle: "start", busy: "join" }, responsibilities }),
  // A chat's type has `present` in place of `admit`: the message its messenger sends.
  // Runs once the delivery has ended, such as to let work that waited on it go.
  settled: async (event, ctx, end) => …,
};
```

The runner passes what `admit` returns to the Process's `deliverEvent`, and
sends what `present` builds through the chat's messenger. The Kernel decides
what each event is and what it does to the process. The Process
decides only what its own state settles. It drops a call's answer for a run
that was aborted or that came before its last reset, and a target change
observed before that reset. It records a failed approval request only while
that request is still pending.

- **Atomic append.** A producer's state never changes without its event, and an
  event never exists without that state.
- **Inline first.** Chat, messengers, `proc.send` and IPC deliver their event
  within the call that appended it. When the process can't take it right now,
  the call still succeeds with `queued: true` and the runner retries.
- **Lanes.** Each process has a `person` lane for a person's messages and a
  `background` lane for everything else. Each lane delivers in order, and a
  person's message never waits behind background events. A wake batch has no
  lane, so a contact message that keeps failing never holds the ledger's wakes.
  A chat has one `messages` lane, so its replies arrive in the order they were
  written.
- **At least once.** A lost answer redelivers. The Process dedupes by the
  delivery's id, `evt_<seq>:<consumer>`.
- **Withdrawal.** The runner withdraws a delivery whose process is gone, one
  whose owner's account was removed before its first attempt, and one its
  definition gives a reason for: a blocked contact, a removed schedule, a newer
  change for the same target. A withdrawn delivery makes no call.
- **Retry.** Attempts to a process back off from 2 s, doubling to 256 s,
  without a limit. A chat's reply is tried twice more, after 2 s and then 8 s,
  and only when its messenger says nothing went out. The runner re-arms its task
  instead of waiting inside the alarm. A refusal, as when a message's media can
  no longer be read, fails the delivery at once.
- **Gate.** While the space isn't active, the runner parks and checks again
  every 60 seconds.
- **Retention.** A settled event keeps its body and outcomes for 30 days, then
  its type and key until day 180, so a duplicate that arrives late still
  appends nothing.

## Event types

| Type | Appended for | Goes to · lane | Idle | During a run |
|---|---|---|---|---|
| `message.received` | chat, a messenger, a person's `proc.send` or spawn prompt | the Ship or the routed process · person | start | stop it and start this one |
| `process.message` | a spawn prompt from a process or a schedule | the process · background | start | own run after |
| `work.returned` | `/ship` on a messenger | the Ship · person | start | own run after |
| `ipc.message`, `ipc.call` | another process's message or call | the target · background | start | own run after |
| `ipc.reply`, `ipc.timeout`, `ipc.overdue` | a call's end or check-in | the caller · background | start | join the run that asked; own run after during another |
| `contact.message` | a contact's message the Ship handles | the Ship · background | start | join |
| `owner.notified` | a notice the person was sent | the Ship · background | record | join |
| `responsibility.ready` | work that came due on the ledger | the Ship · no lane | start | join |
| `schedule.fired` | a schedule aimed at a process | the process · background | start | join; own run after with a reply destination |
| `target.status` | a watched target connecting or disconnecting | the watching process · background | start, or record when only the person sees it | join |
| `chat.reply` | a run's message, approval request or failure notice, on a messenger route | the route's chat · messages | send | send |
| `delivery.failed` | a `chat.reply` that ended unsent | the run's process · background | start for a message; otherwise record | join for a message; otherwise record |
| `source.event` | a hook or `event.emit` | no one: the source's list and its check for repeats read it | — | — |

Inbound mail, memory reviews and the welcome have no event of their own. Each
is a responsibility, which reaches the Ship as `responsibility.ready`.

## Replies to a messenger chat

A run that answers on a messenger route appends a `chat.reply` when it commits
a message, waits on an approval, or fails without answering. The chat's id is
derived from the owner, adapter, account and surface, so no provider's id names
a consumer.

```text
run commits a message ──▶ chat.reply ──▶ chat:<id> · messages lane
                                           ├─ sent ─────────────▶ delivered
                                           ├─ nothing went out ─▶ again after 2 s, then 8 s
                                           └─ refused, maybe sent, or out of retries
                                                 │  in the same transaction
                                                 ▼
                                       delivery.failed ──▶ proc:<pid>
                                         a message: start or join the process's run
                                         an approval or failure notice: record
```

- **References.** A message's text, media and choices stay in its
  Conversation, read when it goes. An approval request is read from its process, and goes only
  while that exact request is pending.
- **No duplicates.** A reply that may already have arrived is never retried.
  The messenger dedupes each retry by the reply's stable delivery id.
- **Wake.** A failed message wakes the process that wrote it, which can reach
  the person another way, such as with `message send --to` another chat. After
  three failed messages in a row to one chat, each further failure is only
  recorded until a reply gets through there, so a chat that keeps failing can't
  keep its process busy. A failure is also only recorded when its run was
  stopped or replaced by a newer message, or the process was reset after the
  message was written: late news of that work starts and joins nothing.

## Outside the log

- **Outboxes.** The federation outbox, outbound mail and the owner's
  messenger notices keep their own tasks and retry rules. An outbox may append
  an event in the transaction that records its outcome, as a notice round
  appends `owner.notified`.
- **Answers inside a run.** Approvals, tool results and the Process tick
  resume work that was already admitted, so they are not events.
- **Responsibilities.** The ledger stays state: what is owed and when. A
  delivery that hands its run responsibilities marks them delivered as it
  ends, which arms the ledger's recovery wakes. Those cover a run that fails
  or never starts, so the log never redelivers.

## Adding an event type

1. Define it beside its producer, with a body schema and the definition's
   `routes` and `admit`, or `present` for a chat, and register it in
   `kernel/events/registry.ts`.
2. Append it with `ctx.events.append` inside the producer's transaction, then
   `kick()` the runner, or call `deliverNow` on a request path.
3. Test it with a real Kernel and Process: append, deliver, and read the log
   and the process's history.
4. Add it to the census, below. The registry's own test fails until you do.

## The census

`test-integration/event-census.test.ts` fires every producer on one clean
instance, with a second Ship only to send a contact's message, then reads the
log. It checks three things:

- every type in the registry was appended and delivered where its row in the
  table above says;
- no Process refused a delivery; only a chat's reply may end unsent, as the
  census's undeliverable reply does, and its process must be woken for it;
- every run in every live process's history was started or joined by a
  delivery the log made to that process. A run's id is the id its delivery
  recorded, so a run that came any other way shows up by name.

`kernel/events/registry.test.ts` keeps the registry and the census's list in
`test-integration/census-types.ts` equal, so a new type can't skip the census.

The runner is `kernel/events/runtime.ts`, the tables and retention are in
`kernel/events/store.ts`, a chat's replies are `kernel/chat-replies.ts`, and
the Process's entry is `process/controller/events.ts`. See [Process IPC and Scheduler](./process-ipc-and-scheduler.md)
for calls and schedules, and [Responsibilities and Context Epochs](./responsibilities-and-context-epochs.md)
for the responsibility ledger.
