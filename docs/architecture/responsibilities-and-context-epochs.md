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
Ship's judgment is required. A user interaction becomes a responsibility when the
Ship accepts work that will outlive the current run.

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
responsibility ids and admits a typed `r12y.ready` runtime event to the existing
personal Process. An idle Ship starts a run; a busy Ship receives the event in its
current run. The event is a Process-context fact, not a canonical user Message.

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

Later responsibility changes do not rewrite the system prompt. The Kernel admits
ordered typed delta events such as:

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

Normal run completion does not rebuild the epoch. On compaction or reset, Process
renders a fresh baseline at the latest ledger revision and excludes superseded
responsibility delta events from the next live context. A hard removal is logically
effective as soon as its delta arrives; physically removing earlier prompt tokens
requires an epoch rotation.

## Epoch archives

Closing an epoch produces an immutable, reproducible archive rather than only a
transcript fragment. The archive manifest identifies:

- the exact rendered system prompt;
- source context sections, sizes, and content hashes;
- the initial responsibility snapshot and revision;
- ordered responsibility and GSV event deltas;
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
