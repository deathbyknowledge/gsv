# Responsibilities and Context Epochs

GSV represents unresolved work with one Kernel-owned primitive: a responsibility,
abbreviated `r12y`. A responsibility may originate in a user interaction, a typed
runtime event, a schedule, another Process, or the Ship itself. Promises, maintenance,
delegated work, follow-ups, and recovery are variations of the
same record rather than separate task systems.

The user's personal Process remains the Ship: the one intelligence that receives
direct conversation and owner-level events. There is no maintenance supervisor or
second hidden intelligence. Kernel SQLite owns durable responsibility state and
deadlines; the Ship decides what to do; ordinary child Processes execute delegated
work.

## Facts, interactions, responsibilities, and Messages

These boundaries are intentionally distinct:

- An **interaction** is live input from a user or peer. It may be answered during the
  current run without creating durable work.
- An **event** is an immutable fact such as mail arriving, a Process finishing, a
  machine disconnecting, or context pressure crossing a threshold.
- A **responsibility** is unresolved work that must survive the current run.
- A **Message** is an intentional delivery to a user conversation. Raw model output
  remains Process Activity.

Deterministic components own ordinary retries and bookkeeping. They create or update
a responsibility only when work remains unresolved, a deadline must survive, or the
Ship's judgment is required. The source subsystem keeps the authoritative evidence:
mail bytes remain in the mailbox, schedule definitions and occurrences remain in the
scheduler, and delegated results remain in Process IPC and activity. The responsibility
stores the unresolved action and stable references to that evidence. A user interaction
becomes a responsibility when the Ship accepts work that will outlive the current run.

Not every `[GSV EVENT]` is an obligation. For example, returning from a Work session
is immediate conversational context and remains a Process event. Responsibilities
replace ad hoc action-bearing wake events; they do not replace typed evidence,
lifecycle signals, or conversation input.

## Ownership

Kernel SQLite stores the authoritative responsibility ledger, its monotonic revision,
transition journal, assignments, deadlines, and wake records. Records are scoped to
the owning human uid inside the installation Kernel. This is the same coordination
boundary that owns identities, Processes, schedules, and routing; no additional
Durable Object is introduced.

The personal Process owns only its current execution and the model context through
which it observes responsibility state. Replacing or resetting that Process cannot
lose responsibilities. A delegated child receives only its assigned responsibilities
and associated parent records. It reports to the Ship by default. An explicit audience
records the conversations authorized for a later delivery policy; this batch does not
let a child bypass the Ship's ordinary result path.

## Responsibility records

A responsibility has one identity and state machine. Optional fields describe its
source, audience, hierarchy, assignment, deadline, and blocker without
creating separate commitment or duty concepts.

```text
r12y:<id>
  owner
  title and bounded structured data
  source interaction/event/process/schedule
  parent responsibility
  audience
  assignee: ship or process pid
  state: open, active, waiting, resolved, cancelled
  priority
  due time and next check time
  blocker and lease
  creation, update, and resolution timestamps
```

Parent links express plans and delegation. Resolving internal children does not by
itself resolve a parent whose promised user-visible outcome has not occurred.
Resolution may retain evidence such as a committed Message id, completed Process run,
or recovered component state.

Every mutation increments the owner's ledger revision and appends one transition.
External producers use a stable deduplication key so a replay returns the same
responsibility rather than creating another one.

## Wake batches

The existing Kernel durable-task scheduler owns responsibility deadlines. The Kernel
maintains at most one earliest wake task per owner. Persisting or changing a
responsibility happens before its wake is scheduled.

When work becomes actionable, the Kernel creates a batch containing the relevant
responsibility ids and admits a typed `r12y.ready` control event to the existing
personal Process. An idle Ship starts a run; a busy Ship attaches the batch to its
current run. The control event contributes no separate model-visible prose. The
responsibility baseline or revisioned ledger transition is the sole model-visible
projection of the obligation.

A responsibility-triggered run may yield only after every record in its current batch
is resolved, delegated, waiting, or explicitly deferred. The overall ledger need not
be empty. Future and delegated records retain their own wake conditions.

Delivery is revisioned and idempotent. If event admission fails, the persisted batch
remains pending and the Kernel scheduler retries it. A recovered Ship requests any
missing transitions after its last observed revision before generating.
After successful admission, actionable work gets a five-minute recovery wake. Any
real state change clears that retry and installs the record's new deadline, lease, or
check condition. This prevents a provider or terminal-action failure from silently
stranding an otherwise open responsibility without polling deferred or delegated work.

## Context epochs

A context epoch is the stable model-context baseline shared by one or more Process
runs. A run begins with admitted work and ends at `yield`; an epoch ends only when the
effective baseline is replaced by reset, compaction, Process replacement, or a
standing-context change.

At epoch creation, Process assembles the exact rendered system prompt and renders the
current responsibility names, ids, and initial states through the `{{ r12y }}` system
context template. It records the corresponding Kernel ledger revision. That rendered
system prompt remains byte-for-byte fixed for the epoch.

Later responsibility changes do not rewrite the system prompt. Before each provider
turn, Process synchronizes ordered transitions after the epoch's last observed ledger
revision and persists them as events such as:

```text
[GSV EVENT]
Responsibility ledger revision 185.
Responsibility `r12y:alpha` changed.
State: active -> waiting.

[GSV EVENT]
Responsibility ledger revision 186.
Responsibility `r12y:beta` was resolved.
```

The model's current view is the frozen baseline plus ordered deltas. These events sit
after the previously cached prompt and history, preserving provider prefix/KV cache
reuse. `r12y list` remains the authoritative on-demand query.

The same epoch owns a normalized availability projection for accessible online
targets, ready MCP servers, current date and timezone, and the visible skill catalog.
Before every provider turn, Process asks the Kernel for the current prompt-relevant
snapshot and compares it with the last observed projection. A meaningful change is
persisted as one bounded `[GSV EVENT]` in the Process Activity, and the event message
and observed projection advance commit atomically. A disconnect and reconnect between
observations therefore produces no artificial activity. These changes do not rotate
the epoch or mutate tool definitions; routable tools keep a stable target schema and
the agent uses `targets list` for the authoritative live view.

An unavailable projection source is not an empty source. If a catalog refresh fails,
Process retains that component of the last observed projection and emits no removal
event until the Kernel can provide another authoritative snapshot.

The epoch source manifest retains the initial projection that rendered its prompt,
while the epoch row and archive retain the last observed projection. Projection event
messages remain ordinary Process Activity until the epoch is archived. Compaction,
reset, or a real standing-context replacement archives those exact messages before
removing them from live history and rendering the replacement baseline.

If a responsibility is created while a provider call is already running, Process does
not mutate that call's system prompt. The ready batch prevents the run from yielding
the new work unseen. The next provider turn synchronizes and appends its transition.
This remains true across normal run completion: the next run continues the same epoch
and still does not rerender `{{ r12y }}`.

On compaction, reset, Process replacement, or an effective standing-context change,
Process closes the epoch and renders a fresh baseline at the latest ledger revision.
That new epoch excludes superseded responsibility delta events from its live context.
A hard removal is logically effective as soon as its delta arrives; physically
removing earlier prompt tokens requires an epoch rotation.

## Deterministic producers

The Standing projection also names three required runtime contracts:

- `interaction.response` keeps a direct interaction running until Ship sends a
  Message or explicitly chooses silence. A response completed within that run does
  not need a durable ledger record.
- `process.delegation` guarantees that a linked, still-active assignment returns to
  Ship on every terminal child outcome.
- `schedule.due` guarantees that each occurrence of an enabled Ship responsibility
  schedule becomes durable work.

They are always on. Configurable producers, beginning with `mail.received`, may be
enabled or disabled per owner without changing the subsystem's underlying data.

System-owned producers use the same ledger contract:

- Provisioning a new personal intelligence creates one high-priority initial
  onboarding responsibility. It waits for the user rather than waking the Ship on
  its own, is present in Ship's first context epoch, and remains unresolved until
  the user confirms setup is complete. This replaces the generated boot context
  file.
- Managed mail completion creates one `mail.received` responsibility keyed by the
  immutable message id. The title contains no sender-controlled text. Bounded summary
  metadata is marked untrusted and is available only when the Ship inspects the record;
  exact content stays in the mailbox.
- Activating either side of a contact invite creates one generation-scoped
  `contact.added` responsibility. It asks Ship to learn about the contact and preserve
  useful context in the owner's existing knowledge system without assuming a specific
  wiki or inventing missing facts. Acceptance retries return the same responsibility;
  pairing again after revocation creates another for the new generation.
- The first registration of a physical machine creates one `machine.added`
  responsibility. Browser-backed targets and later reconnects do not create another.
- An owned messaging account first becoming connected and authenticated creates one
  `adapter.connected` responsibility. A later authentication loss creates a recurring,
  deduplicated `adapter.auth_required` responsibility that resolves automatically when
  authentication returns. The adapter status persists which owner has already observed
  readiness, and upgrades backfill ready owned accounts, so transport-only reconnects
  do not create new-account work. An intentional disconnect cancels obsolete recovery
  work instead of leaving Ship responsible for reconnecting it.
- A Ship-directed schedule occurrence creates one `schedule.due` responsibility keyed
  by schedule id and occurrence id. Replaying the occurrence returns the same record.
  Schedules explicitly bound to an adapter reply route retain that transport event so
  the eventual Message can use the exact authorized destination.
- `proc delegate --responsibility ID ...` stores the responsibility id on the durable
  IPC call. Completion, failure, timeout, or kill returns a still-active assignment to
  Ship exactly once, records the call and child run ids as evidence, and wakes Ship.
  The child result itself remains an IPC event in Process Activity.

## Epoch archives

Closing an epoch produces an immutable, reproducible archive rather than only a
transcript fragment. The archive manifest identifies:

- the exact rendered system prompt;
- source context sections, sizes, and content hashes;
- the initial responsibility snapshot and revision;
- ordered responsibility and GSV event deltas;
- the initial and last-observed availability projections;
- Process messages, reasoning, tools, results, and run boundaries;
- offered tool schemas, targets, and model parameters;
- committed user-visible Message references; and
- immutable file and media resource revisions.

The exact rendered prompt is authoritative for replay; the source manifest explains
how it was assembled. Context compaction closes the previous epoch, archives its exact
activity snapshot, installs the transcript summary, and opens a new epoch with current
standing context and responsibilities. Public dataset export is an explicit, user-controlled
projection of this complete private archive, never an automatic publication path.

## Agent interface

Responsibilities do not add a model tool. Kernel syscalls are exposed through the
native `r12y` shell command and CodeMode in the same way as other composable runtime
operations:

```text
r12y list
r12y show ID
r12y create ...
r12y update ID ...
r12y resolve ID ...
r12y wait ID ...
r12y delegate ID PID --until ISO
r12y cancel ID ...
```

The Kernel derives owner and caller Process identity from the authenticated frame.
Callers cannot select another owner's ledger or assign work to a foreign Process.

## Invariants

- There is one responsibility mechanism, one scheduler path, and one Ship.
- Kernel state is authoritative; prompt projections are revisioned snapshots.
- A normal run never rewrites its context epoch baseline.
- Missing deltas are recovered before generation.
- User input remains admissible while responsibility work is active.
- Child completion always reaches its parent even when no user Message is sent.
- Responsibility terminal transitions never delete canonical conversation Messages
  or archived Process Activity.
- Epoch closure either installs a complete new baseline and archive reference or
  leaves the old epoch live.
