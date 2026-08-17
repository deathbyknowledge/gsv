# Universal Routing Graph and Surface Bindings (Proposal)

Status: **design only**. No `route.*` runtime, schema, CLI, Process admission
path, or client surface inbox described here has been implemented. The names
and wire shapes below are proposals, not compatibility promises.

GSV has one durable conversation primitive: the Process. Adapter chats, native
windows, and terminal sessions are interaction surfaces through which messages
enter or leave Processes. The Kernel should represent those relationships as a
small directed routing graph so a user can manage them consistently and, when
explicitly configured, route one Process's replies into another Process.

The graph does not replace exact run replies. It separates four mechanisms that
have different owners and lifetimes:

| Mechanism | Example | Lifetime | Meaning |
|---|---|---|---|
| Interactive binding | Native Main -> Research Process | Durable, revisioned | Which Process receives the next input from a surface |
| Exact run reply route | Run 42 -> the WhatsApp thread that started it | One run, through terminal delivery | Where that exact interactive run replies |
| Durable output edge | Research Process -> Editor Process | Durable, revisioned | Where committed future outputs are additionally delivered |
| Live attachment | This native window observes Research Process | One authenticated connection | Which Process signals a connected UI observes |

A **sink** is simply the destination port of a durable output edge. It is not a
second conversation id, a mutable field on a run, or a provider address.

This is a message-flow graph, not a replacement for target-aware syscall
routing. Device/browser `target` selection, routed shell sessions, explicit
one-shot `message send`, and adapter administration retain their existing
contracts.

It also does not replace existing Process IPC. `proc.ipc.send` is an explicit
one-shot same-owner delivery to a selected PID; it does not subscribe the
target to future source output. `proc.ipc.call` is the bounded request/reply
primitive: the Kernel keeps its exact call id, source run, deadline,
cancellation, and later `ipc.reply` or `ipc.timeout` delivery to the calling
Process. A durable output edge is asynchronous future-output routing and has no
implicit return path. Code that needs one bounded answer from another Process
continues to use `proc.ipc.call`; graph delivery must not intercept, duplicate,
or reinterpret that call's reply.

## Graph model

The first version has two node kinds and four typed ports:

| Node | Input port | Output port |
|---|---|---|
| Interaction surface | `surface.ingress` | `surface.egress` |
| Process | `process.input` | `process.output` |

Only these relationships are valid initially:

```text
surface.ingress  -- interactive binding --> process.input

process.output   -- durable output edge --> process.input
process.output   -- durable output edge --> surface.egress

interactive input -- exact run reply route --> originating surface.egress
```

The first line selects a Process for user input. The middle lines are the
optional sink graph. The final line is captured for one run at admission and
is deliberately not a graph edge.

For example, a WhatsApp conversation and a native window can both be bound to
the Research Process. A durable output edge can additionally feed Research's
committed answers to the Editor Process. Rebinding WhatsApp later changes only
future WhatsApp input. It does not move an admitted run, change Research's
edge to Editor, or redirect an answer already owed to WhatsApp.

An output edge carries only a committed successful assistant result: its text
and final response attachments. It does not forward stream deltas, hidden
reasoning, tool calls, work-activity signals, approvals, errors, or lifecycle
signals. A Process-to-Process delivery becomes identified inbound content for
the destination Process; it never masquerades as a human message. It may start
a destination run, but does not synthesize an implicit reverse edge. The
destination's eventual output follows its own configured edges.

The automatic exact reply remains enabled for interactive runs. Output edges
are additional delivery, not a way to steal or silently replace the answer
owed to the user who initiated that run. If an output edge names the same
surface already captured as the exact reply destination, the exact reply wins
and the edge receipt is recorded as a suppressed duplicate.

Exact reply streaming and terminal delivery do not wait for graph fan-out. An
edge failure is an inspectable delivery failure, not a failure of the source
run and not a reason to withhold its answer from the initiating user. A
scheduled, background, or graph-originated run may have no interactive exact
reply route; its committed result can still follow configured output edges.

## Invariants

- The PID remains the only Process and history identity. Graph node and edge
  handles are selectors, not new conversations.
- The Kernel owns endpoint identity, bindings, exact run reply routes for
  interactive surface admissions, output edges, delivery planning,
  authorization, and receipt reconciliation.
- A surface binding resolves once for each admitted input. Rebinding affects
  later input, never an already admitted or queued run.
- For an interactive surface admission, the Kernel allocates the `runId` and
  persists the exact run reply route before the Process can emit a signal or
  output. Background, scheduled, IPC, graph, and direct route-less admissions
  do not invent an interactive reply route.
- An exact run route retains its `runId`, PID, owner, origin, and destination
  snapshot through its terminal delivery outcome. Graph edits cannot mutate it.
- A live attachment is pinned to an exact PID. It does not silently follow a
  binding change and is not a durable output destination.
- Output edges are evaluated only after the source Process has durably committed
  its canonical final output and outbox row atomically. Each source output and
  each edge delivery has a stable idempotency identity.
- Process-to-Process delivery never creates an automatic reply-to-source path.
  A return path must be an explicit, valid edge, and cyclic graphs are rejected
  in the initial design.
- Binding, endpoint, and edge revisions never move backwards or reset. Deletion
  and retirement leave tombstones so a stale compare-and-swap cannot pass
  through an ABA cycle.
- Raw adapter, provider, account, actor, conversation, channel, thread, message,
  and connection identifiers remain inside the Kernel/adapter boundary.
  Generic APIs, clients, CLIs, and Processes receive only owner-authorized
  opaque handles and bounded display metadata.
- A handle or stale route record is not authority. Graph reads and mutations
  check caller authority; admission checks source authority; edge creation
  durably grants autonomous future delivery for the owner. Each delivery then
  validates that the grant is still enabled, same-owner, and attached to live
  authorized endpoints. It does not require the absent creator to reauthorize
  every output.
- Every output edge is an explicit owner-owned grant with creator, approval,
  revision, and revocation audit; knowledge of an edge handle grants nothing.
- Late completion from a cancelled, expired, superseded, or fenced delivery
  cannot admit a new run or alter a newer receipt.

## Endpoint identity and public handles

The Kernel stores platform addresses separately from public endpoint identity:

```ts
// Kernel-internal only. Never returned by a generic syscall or signal.
type InternalSurfaceAddress =
  | {
      kind: "adapter";
      adapter: string;
      accountId: string;
      actorId: string;
      surfaceKind: "dm" | "group" | "channel" | "thread";
      surfaceId: string;
      threadId?: string;
    }
  | {
      kind: "client";
      clientKind: "native" | "web" | "tty";
      instanceId: string;
      slot: string;
    };
```

The Kernel assigns stable, random owner-scoped handles such as `endpoint_...`
and `edge_...`. A handle cannot be decoded into an adapter or provider id and
is not a credential. Every use still checks the caller's uid and capabilities.

```ts
type RouteEndpoint = {
  endpointId: string; // Opaque owner-scoped handle.
  kind: "surface" | "process";
  ports: Array<"surface.ingress" | "surface.egress"
    | "process.input" | "process.output">;
  display: {
    name: string;
    context?: string;
  };
  state: "active" | "unavailable" | "retired";
  revision: number;
  // A Process endpoint may include its already-public same-owner PID and label.
  process?: { pid: string; label?: string };
};

type InteractiveBinding = {
  surfaceEndpointId: string;
  processEndpointId: string | null;
  state: "bound" | "unbound" | "retired";
  revision: number;
  updatedAt: number;
};

type OutputEdge = {
  edgeId: string;
  source: { endpointId: string; port: "process.output" };
  destination: {
    endpointId: string;
    port: "process.input" | "surface.egress";
  };
  state: "enabled" | "paused" | "blocked" | "retired";
  revision: number;
  grant: {
    createdAt: number;
    createdBy: {
      kind: "human" | "process" | "root";
      display: string;
      process?: { pid: string; label?: string };
    };
    approvedAt?: number;
  };
  revokedAt?: number;
  updatedAt: number;
};

// Public, history-safe provenance. This is never a delivery address.
type InteractionOrigin = {
  originId: string; // Opaque owner-scoped origin or endpoint handle.
  kind: "surface" | "process" | "scheduler" | "device" | "local";
  display: { name: string; context?: string };
  reply: "automatic" | "ipc-call" | "none";
  process?: { pid: string; label?: string };
};

// Kernel-internal exact interactive routing data, separate from InteractionOrigin.
type InternalInteractiveRunReplyOrigin =
  | {
      kind: "adapter";
      surfaceEndpointId: string;
      address: Extract<InternalSurfaceAddress, { kind: "adapter" }>;
      providerMessageId?: string;
    }
  | {
      kind: "connection";
      connectionId: string;
      surfaceEndpointId: string;
    };
```

Display text is bounded, non-authoritative metadata such as “WhatsApp · Design
group,” “Native · Main,” or “Editor.” It is suitable for a picker or approval,
but never for address reconstruction or authorization. Adapter surfaces become
visible only after joining their exact internal tuple to a current owner
identity link. No raw tuple is present in a graph row exposed to a caller,
delivery receipt, signal, log, or approval.

Process endpoints are created with the Process registry row and retain the
same PID. Accepting a PID in a human-facing CLI is only an ergonomic lookup:
the Kernel resolves it to the same-owner endpoint before changing the graph.

`InteractionOrigin` is the only provenance type that crosses into Process
history, model context, the public SDK, client history, or a generic signal. It
can say “WhatsApp · Design group,” “Editor Process,” or “scheduled work” and
whether a reply is automatic, but it cannot be used to deliver that reply. The
exact adapter address, provider reply id, connection id, or IPC call
correlation remains in Kernel-internal state. Interactive replies use the
separate run route; bounded `proc.ipc.call` replies continue to use the existing
IPC call ledger and deadline path rather than either the graph or the run-route
table. Context assembly uses the redacted origin for presentation and the
immutable internal route for behavior; it never reconstructs routing from
display metadata.

## Interactive bindings and exact replies

### Adapter surfaces

Adapter ingress keeps its current normalized actor-scoped identity. After
authenticating the adapter service and resolving the linked actor, the Kernel
maps the internal address to an opaque surface endpoint. The surface's binding
selects the Process for new input. An absent binding can invoke the durable
spawn-and-bind operation described below.

The shared `route.surface.send` saga below claims adapter ingress, allocates the
run id, and persists an exact adapter run reply route containing the internal
destination snapshot and stable outbound delivery id. Provider threading,
typing, retries, and final provider delivery remain owned by the adapter and
that exact route. A later binding or edge change cannot redirect the reply.

### Native, web, and TTY surfaces

A native installation, web profile, or CLI profile has a locally persisted
`instanceId`; a named window or terminal chat has a stable `slot`. An
authenticated human bootstrap resolves that pair to the caller's opaque
surface endpoint. Neither value is a credential, and another caller listing
the graph never receives them.

The surface binding selects the Process for the next composer or terminal
input. A window then attaches to the exact selected PID for live signals. An
explicit `--pid` is an invocation-scoped attachment and does not rewrite a
binding unless the user asks to bind it. History remains authoritative for
reconnect and gap recovery.

The WebSocket connection id is ephemeral lifecycle metadata, not the surface
key. Reconnects for one window may supersede its old socket; different windows
and terminals may coexist even when bound to the same Process.

For an interactive client run, the exact reply route remains tied to the
originating connection/surface and run id as today. A disconnected native or
TTY client can recover the committed answer from Process history. A future
durable client-surface egress inbox may support unsolicited output edges while
the client is offline, but that inbox and acknowledgement protocol are part of
the runtime work still to be designed and implemented. Until it exists, the
Kernel must reject durable output edges to client surfaces rather than pretend
that a live WebSocket is durable.

### Surface-aware admission saga

Every interactive surface input enters through one Kernel-owned
`route.surface.send` admission service. Native/web/TTY callers use the public
syscall for the authenticated surface they opened. Authenticated adapter
ingress resolves its raw address internally and invokes the same service; its
stable provider `deliveryId` is the service's `inputId`, not a second
independent deduplication system.

The operation is ordered as follows:

1. Authenticate the caller's authority over the surface, claim `inputId`, and
   bind it to a canonical digest of the surface handle, reply mode, optional
   invocation-scoped Process selection, the exact normalized UTF-8 text bytes,
   and the ordered media manifest. Each media entry includes its position,
   bounded name/type/size metadata, declared content digest, and body range.
   A retry with changed bytes, order, metadata, selection, or reply mode is a
   conflict. For the same digest, an accepted/terminal claim returns its stored
   result and cancels the duplicate body; a concurrent claim with a live
   transfer owner also cancels the duplicate body and reports in-progress.
   An expired or abandoned pre-admission transfer is different: the retry
   atomically advances an attempt generation, fences the dead owner, and may
   re-stream the same fingerprint instead of being discarded.
2. Select the Process exactly once. Normally the Kernel resolves the current
   interactive binding and fences its revision. A native/TTY invocation such as
   `--pid` may instead supply an optional same-owner Process endpoint and
   endpoint revision; the Kernel validates and persists that invocation-scoped
   fence without reading or rewriting the durable surface binding. The choice
   is part of the input digest, so retry cannot change it. A later rebind or
   Process retirement cannot move the admitted input. An unbound surface with
   no invocation selection returns an explicit result or, where first-use
   policy permits, runs the same idempotent spawn-and-bind saga under a child
   operation id derived from `inputId`, then resumes this operation; it never
   guesses from process recency or spawns twice on retry.
3. Allocate the final `runId`. Derive a redacted `InteractionOrigin` for
   Process history and capture the exact internal reply destination for this
   input. In the same Kernel transaction, persist the ingress state and exact
   run reply route plus its immutable `{ exactReplyRunId,
   exactReplySurfaceEndpointId }` tombstone before calling a Process or
   accepting any media bytes.
4. Only after that commit, transfer media into the selected Process's scoped
   staging area under the stable input/run identity. The Process accepting the
   body owns complete consumption, cancellation, and partial-upload cleanup.
   Attempt generation is only a lease/fence, not part of the staging identity:
   takeover cleans or replaces partial objects and re-streams into the same
   stable `{ pid, runId, inputId, media position }` identities. Every chunk and
   finalize request carries the current generation, so late bytes or completion
   from the fenced owner cannot mutate or admit the retry's staging.
   It computes each content digest while streaming and returns a finalized
   ordered staging-manifest digest. Before admission, the Kernel verifies that
   manifest against the exact ordered media content and metadata committed in
   the ingress digest; a missing, reordered, truncated, or changed item fails
   closed and cleans up staging.
5. Admit the normalized input with the preallocated `runId`, `inputId`,
   redacted origin, text, and finalized media references. The Process claims
   the input identity atomically with its history append/queue transition and
   returns the same admission result on retry.
6. Mark the Kernel ingress operation accepted. If a response is lost, alarm or
   caller retry reconciles the Process claim before dispatching again. A
   terminal pre-admission failure removes the unused run route and staged
   media; cancellation after admission reports the accepted run and requires
   normal `proc.abort` if the caller wants to stop it.

Consequently, an interactive client never performs “resolve binding, then
`proc.send`, then install a reply route” as separate calls. Even immediate
stream, activity, or HIL signals have a route, and a retry cannot create a
second run. The raw provider/connection destination exists only in the Kernel
ingress and run-route records; the Process receives only `InteractionOrigin`.

### Live observation

Attachments remain separate from both binding and delivery. They let an
authenticated connection observe signals for an exact PID. Ordinary
`proc.run.*` signals go to the exact connection reply route and authenticated
attachments, with duplicate delivery to the same connection suppressed. HIL
retains its owner-wide security semantics: every connected owner client may see
and answer it, and adapter approval still requires the exact pending token.

Binding changes may invalidate a client's selection, but never silently move a
live attachment during an active or queued run. Disconnect and supersession
remove attachments and connection reply routes without changing bindings,
edges, Processes, queues, or history.

### Trace admission contract

Every admission that can eventually commit assistant output carries a durable
`RouteTrace`; graph routing is not limited to surface-originated runs.

- `route.surface.send` seeds a new trace from `inputId` and records the exact
  reply surface endpoint when it has one.
- A direct `proc.send` from outside a Process seeds a new trace. A `proc.send`
  issued by a Process during a run inherits that run's trace while creating a
  new parent event and causal branch. It remains a direct one-shot admission,
  not a durable edge and not an interactive exact reply.
- `proc.ipc.send` and `proc.ipc.call` inherit the calling source run's trace and
  extend its path ancestry for the target admission. Their stable IPC message
  or call id is the new parent event id. The target's assistant output is
  therefore eligible for its normal output edges like any other committed
  output.
- Scheduler occurrences, direct background work, and other root admissions
  seed a trace from their stable occurrence/admission id. A graph delivery
  inherits its source trace as described below.

Trace propagation does not change reply semantics. In particular,
`proc.ipc.call` continues to keep its call id, source PID/run, deadline,
cancellation, terminal result, idempotent retry job, and bounded
`ipc.reply`/`ipc.timeout` delivery in the existing Kernel IPC call ledger. The
target's graph outbox may independently fan out its committed output; it cannot
satisfy, delay, consume, or duplicate the IPC call reply. If the delivered IPC
reply itself starts/queues output-producing work in the source Process, that
admission inherits the same trace and gets its own event/run identity.

## Durable output-edge delivery

An output edge is durable configuration, but each output is a separate durable
delivery saga. There is no atomic transaction spanning the source Process DO,
Kernel DO, destination Process DO, and adapter account DO.

### Source commit and planning

The Process cannot safely emit a best-effort `process.output.ready` after
committing history: a crash between those operations would lose graph delivery.
Instead, the source Process owns a durable output outbox.

1. In one Process SQLite transaction, it appends the final assistant record and
   creates an outbox row with stable `outputId`, run id, owner, trace envelope,
   immutable message/media references, a canonical payload fingerprint, and a
   delivery lease. There is no state in which history contains a routable
   output but the outbox does not.
2. The Process schedules its alarm in the same durable operation and attempts a
   Kernel handoff after the transaction commits. The request carries bounded
   metadata and immutable references, not copied text or media bytes.
3. The Kernel idempotently claims `outputId` plus its fingerprint. In one Kernel
   transaction it snapshots the enabled outgoing edge ids and revisions,
   applies fan-out limits, copies immutable `exactReplyRunId` and
   `exactReplySurfaceEndpointId` into the output plan, suppresses an edge only
   when the outbox `runId` equals `exactReplyRunId` and its destination equals
   that surface endpoint, creates zero or more non-dispatchable delivery
   receipts, and records the
   output event as planned. A retry with another fingerprint is a hard conflict.
4. For each accepted receipt, the Kernel asks the Process to atomically replace
   the outbox's temporary handoff lease with a stable immutable read lease keyed
   by `deliveryId`. The Process returns the existing lease on retry. Only after
   every accepted receipt has such a lease does the Kernel mark the plan ready.
5. The Kernel durably acknowledges the source outbox, including when the
   snapshot contains **zero edges**. An empty graph is a successful handoff, not
   an outbox row that retries forever.
6. Only after receiving or reconciling that acknowledgement may the Process
   mark the outbox handed off and release its temporary handoff lease. A lost
   acknowledgement is recovered by querying the Kernel's `outputId` claim; it
   is not handled by creating another output event. Per-delivery read leases,
   if any, remain until their delivery owners terminalize and release them.

Until acknowledged, the Process alarm retries with bounded backoff and remains
the owner of the payload. Kernel delivery workers read the exact committed
assistant record through a Process-owned immutable `outputId` read contract;
that read verifies the stored fingerprint and never observes mutable “latest
message” state. The temporary handoff lease survives until the Kernel has
durably snapshotted and acknowledged the plan. Each nonempty plan then remains
protected by its delivery-specific read leases until those receipts terminate.

If reset or kill races handoff, Process cleanup first drains or reconciles the
outbox claim and leases. A pre-acknowledgement reset cannot delete its payload;
a post-acknowledgement Kernel retry reads through its delivery-specific lease.
Each terminal receipt releases that lease idempotently after all owned body
transfers finish or cancel. The last lease permits normal Process cleanup.
Graph tables contain
references and fingerprints, not duplicate prompt, reply, credential, or media
content. Later edge edits do not add, remove, or retarget a snapshotted output;
they affect only output ids not yet claimed by the Kernel.

The duplicate-exact-reply check is run-local and never depends on a live reply
route. Interactive admission durably records a tombstone containing immutable
`exactReplyRunId` plus `exactReplySurfaceEndpointId`. Terminal reply delivery
may remove its raw transport address, but retains that tombstone through the
output-planning and receipt-deduplication horizon. Planning suppresses only
when the outbox row's `runId` exactly matches the tombstone run id and the edge
names its surface. Merely inheriting the origin surface in a downstream trace
does not suppress an intentional later delivery. Output plans and receipts copy
both immutable fields and retain the endpoint's redacted tombstone through
their audit horizon. Retirement can
therefore fail future dispatch safely without losing the identity needed to
explain or deduplicate already planned work.

### Delivery to another Process

The Kernel sends the destination Process a normalized envelope with the stable
delivery id, a redacted `InteractionOrigin` naming the source Process endpoint,
`traceId`, `originEventId`, `parentEventId`, optional
`exactReplySurfaceEndpointId`, path ancestry, hop count, expiry, text body, and
attachment descriptors. The destination Process atomically claims the delivery
id and either:

- persists the identified inbound message and queues one run;
- returns the already-recorded admission result for a retry; or
- returns a terminal rejection without mutating history.

The content is labeled as routed Process output in history and model context;
it is not assigned a human actor role. The destination run executes with the
destination Process's run-as identity and capabilities. Routing never lends it
the source Process's authority.

Media cannot remain aliased through a source Process's private path. Under the
same-owner authorization fence, the receiving Process copies each attachment
into its own process-scoped media storage before committing admission. The
component accepting each streamed body owns consumption, cancellation, and
cleanup. A failed or cancelled copy cannot leave a partial history record.

Admission is the terminal success for that edge delivery. The destination
run's eventual success or failure is a new Process lifecycle, not a reason to
hold the source delivery open. If that destination later commits output, it
creates the next event in the same routing trace.

### Delivery to a surface

For an adapter surface, the Kernel rechecks the current identity link and
destination authority, then hands the exact normalized response to the adapter
using the stable delivery id. The adapter's account-local ledger binds that id
to a fingerprint of destination and content so a retry cannot duplicate or
retarget provider delivery. The receipt becomes terminal only at the adapter's
known success, known failure, or explicit ambiguous-delivery outcome.

For native, web, and TTY surfaces, durable output edges require the bounded
client-surface inbox mentioned above. The Kernel would persist an envelope
reference until an authorized client acknowledges it, while live connections
could receive an immediate invalidation. A socket send alone is never a durable
success. This endpoint type remains unavailable until those semantics exist.

### Receipts and idempotency

Each delivery has an opaque `deliveryId` derived from the immutable source
event identity, edge id, and edge revision. It is stable across retries. The
Kernel retains a bounded receipt with states such as `planned`, `dispatching`,
`accepted`, `delivered`, `retryable`, `failed`, `cancelled`, or `suppressed`.
Receipts expose timings, endpoint handles, attempts, and redacted outcomes, but
never message content or internal transport ids.

Before every side effect, the owning boundary claims the delivery id. After a
crash, the Kernel reconciles an indeterminate receipt with that owner instead
of assuming failure and replaying blindly. Reusing a delivery id with another
source fingerprint, destination, or payload is a hard conflict. Terminal
receipts remain for a bounded deduplication horizon longer than the maximum
delivery retry horizon.

## Traces, cycles, and loop suppression

Every root output-producing admission seeds, and every causal child inherits,
this routing envelope:

```ts
type RouteTrace = {
  traceId: string;       // Stable for the whole cascade.
  originEventId: string; // Stable identity of the initial admitted event.
  parentEventId: string; // Output event that planned this delivery.
  // Original interactive reply surface, if any; provenance, not authority.
  exactReplyRunId?: string;
  exactReplySurfaceEndpointId?: string;
  ancestry: string[];    // Process endpoint ids on this one causal path.
  hopCount: number;
  expiresAt: number;
};
```

Run ids and delivery ids remain distinct from trace identity. A downstream run
inherits the trace, and its committed output increments the hop count when the
Kernel plans the next Process-input delivery. A surface egress is terminal and
does not increment into another internal node. The initial Process seeds
`ancestry` with its endpoint; every branch receives its own copied list.
`originEventId`, `exactReplyRunId`, and `exactReplySurfaceEndpointId` never
change as the trace branches. The endpoint is retained even after it retires because an
opaque endpoint tombstone is stable and contains no raw transport address.

Loop safety has several independent layers:

1. **Static cycle detection.** The Kernel serializes edge mutations and rejects
   any enabled `process.output -> process.input` edge that would make the active
   owner graph cyclic, including a self-edge. Bindings and exact reply routes
   are excluded because neither automatically re-enters a Process output.
2. **Retry duplicate suppression.** The Kernel claims an output once by
   `(source process, outputId)` and a planned edge delivery once by
   `(outputId, edgeId, edgeRevision)`. The destination claims the resulting
   `deliveryId`. Retries at any boundary return the existing record. A trace id
   alone is never a deduplication key: independent outputs in the same cascade
   are distinct work.
3. **Path-local runtime loop suppression.** Each Process-to-Process delivery
   carries the immutable ancestry for its own causal branch. If its destination
   already occurs in that ancestry, the Kernel records a terminal suppression.
   Otherwise it appends the destination before admission. This catches stale
   snapshots, concurrent lifecycle transitions, or defects without globally
   suppressing legitimate reconvergence.
4. **Hop and time bounds.** The Kernel enforces a deployment-wide maximum graph
   depth and trace TTL that an edge cannot override. Expired or over-depth work
   receives a terminal suppressed receipt.
5. **Adapter echo suppression.** An adapter must ignore its own outbound
   provider events and retain provider delivery deduplication. A provider echo
   is a new external event and cannot be made safe by an internal trace id
alone.

A diamond such as A -> B, A -> C, B -> D, C -> D is legitimate fan-in. D may
receive one identified delivery from B's output and another from C's output;
they have different `outputId`/`deliveryId` pairs even though they share a
trace. Per-edge source ordering and destination admission rules determine their
order. Product workflows that need a single joined invocation require an
explicit join/workflow primitive; generic routing neither collapses the two nor
silently drops one.

The initial design intentionally rejects persistent feedback cycles. If GSV
later supports bounded agent debates or iterative workflows, they should be an
explicit workflow primitive with a turn budget and termination contract, not
an `allowCycle` escape hatch on a generic edge.

## Fan-out, ordering, and backpressure

Routing must remain bounded even when every individual edge is valid:

- Each Process has a fixed maximum number of enabled outgoing edges.
- Each trace has a fixed maximum number of planned deliveries across all hops,
  in addition to the depth and TTL limits.
- Per-owner pending-delivery and pending-byte quotas prevent one graph from
  exhausting the Kernel or adapter.
- The Kernel dispatches from a durable queue with bounded concurrency. It does
  not hold a Process request open while a downstream destination is slow.
- Deliveries on one edge preserve source-output order. A retry applies bounded
  exponential backoff and cannot spin in a Durable Object alarm.
- A full destination Process queue or client inbox returns explicit
  backpressure. The receipt remains retryable only until its deadline; it then
  becomes an inspectable terminal failure instead of growing an unbounded
  queue.
- Repeated terminal failures may automatically pause an edge with a reason.
  Resuming it is an explicit revisioned mutation and does not replay expired
  deliveries.

The graph mutation that would exceed a static fan-out bound is rejected. A
runtime trace that reaches its aggregate delivery bound suppresses the
remaining fan-out deterministically and records which edges were not planned.

## Lifecycle and cancellation

Endpoints, bindings, and edges have monotonic revisions. Normal lifecycle
operations preserve inspectable state:

- An unseen surface starts unbound at revision zero. Bind and unbind each
  advance the binding revision; unbind writes a tombstone with no Process.
- Removing an adapter account or identity link retires its surface endpoint and
  advances its tombstone. Reauthorizing the same internal address creates a new
  opaque endpoint rather than reviving the old handle.
- `proc.kill` retires that Process endpoint, advances any binding to an unbound
  tombstone, and blocks incident edges with `endpoint_retired`. It never
  silently retargets an edge to a replacement Process.
- Deleting an edge retires its handle. Recreating the same relationship creates
  a new edge id and revision history.
- Pausing an edge stops planning future deliveries; already planned deliveries
  retain their edge snapshot. Deleting/revoking an edge also stops future
  planning and terminally cancels its not-yet-accepted receipts under the
  revocation rule above.
- `proc.reset` preserves bindings, endpoint identity, and edges. Outputs already
  committed and claimed continue; an aborted active run produces no routable
  successful output.

`proc.abort` stops only the selected active run. It does not recursively abort
a destination run already admitted by an earlier delivery. A pending graph
delivery may be cancelled explicitly by delivery id before destination
admission. Cancellation fences the attempt, cancels any owned body stream, and
records a terminal receipt. If admission won the race, reconciliation returns
the accepted result and the caller must explicitly abort that destination run
if authorized.

`proc.kill` is a coordinated cleanup boundary: it prevents new source events,
terminally cancels non-admitted outbound deliveries whose payload cannot
survive cleanup, reconciles source delivery leases, and only then removes live
Process media. Downstream runs already admitted remain independent durable
Processes.

## Authorization, privacy, and approval

The initial graph is same-owner only. Cross-owner routing is denied rather than
inferred from group membership, shared adapter participation, or knowledge of a
handle. A future sharing design requires an explicit grant at both endpoints.

Each enabled edge is an owner-owned durable grant for one exact source port to
one exact destination port. Its audit record contains the owner uid, opaque
endpoints, creator identity, creation/approval timestamps, revision history,
state transitions, and redacted reasons. A Process-created edge records both
the requesting PID/run and the human HIL decision that authorized the exact
operation arguments. Ownership does not transfer if an endpoint's display name,
run-as account, or binding changes.

The Kernel stores the authenticated creator principal and approving human uid
internally. The public `createdBy` view above is a bounded redaction; its
display string is not the audit identity and cannot authorize another action.

Revocation advances the edge revision and prevents new source outputs from
snapshotting it. It is not retroactive deletion: already planned receipts keep
their immutable edge/grant snapshot for audit, but any not-yet-accepted
delivery rechecks the live grant and becomes `cancelled` with reason
`grant_revoked`. A destination already admitted remains durable Process work;
revocation cannot erase its history or recursively abort its run. Expired or
invalid endpoint authority blocks dispatch even if the grant row still says
enabled. Retired grant handles are never reused.

- Human clients may inspect and mutate their owner graph and attach to
  same-owner interactive Processes under their normal authenticated authority.
- A Process needs separate proposed `route.read` and `route.manage`
  capabilities. Reads return only authorized opaque endpoints and redacted
  receipts. Every Process-originated bind, spawn-and-bind, edge create, edge
  update, edge delete, pause, resume, retry, or cancellation also requires an
  exact single-use HIL decision.
- The Kernel derives the requesting PID, run, owner, and capability context. An
  agent cannot supply a different caller identity or borrow a human CLI token.
- An approval uses concise semantic copy such as “I want to route replies from
  Research to Editor” or “I want to move WhatsApp · Design group to Planning.”
  It shows bounded endpoint display metadata and the effect, never raw provider
  fields or an implementation operation name.
- Devices and schedulers cannot mutate the graph. Root administration, if
  exposed, is a distinct auditable authority path.
- Delivery rechecks both endpoints and current destination authorization. An
  enabled edge is the owner's durable autonomous grant, not a bearer token: the
  Kernel checks the stored grant and endpoint/adapter authority, not whether its
  creator is online or still has `route.manage`. Only owner revocation,
  endpoint retirement/unlink, or another explicit authority change blocks
  delivery and records the redacted reason.
- The destination Process uses only its own identity, groups, capabilities,
  approvals, and target access. Inter-Process routing conveys content and
  provenance, not privilege.
- Graph inventory, receipts, telemetry, and logs contain no prompts, replies,
  attachment bytes, credentials, or raw adapter/provider identity. Content
  remains in Process history or the delivery owner's protected payload store.

For a Process mutation, the requesting Process durably records the pending HIL
against its current source run, `operationId`, canonical digest of the exact
route syscall arguments, and single-use request token before the Kernel makes
any graph side effect. The resumed call must match all of them. HIL remains
owner-scoped for presentation, but only the caller Process consumes the exact
decision. Denial, expiry, run supersession, cancellation, an argument change,
or a stale token returns a normal failure and cannot resume a newer mutation.

## Proposed management surface

The same Kernel contract should back native/web settings and two deliberately
different command frontends:

- The external Rust `gsv` CLI is a human/device client. It opens its own
  authenticated WebSocket connection and uses the human identity and
  capabilities established there. It has no current Process merely because it
  runs on the same machine as one.
- A Process uses a Kernel-native `route` command through its existing Shell or
  CodeMode execution context. That frontend calls the same handlers with the
  Kernel-provided Process identity, current PID, and current run. It does not
  execute the external Rust CLI or read cached human credentials.

This adds no model-facing tool beyond the fixed GSV surface, while ensuring an
agent cannot accidentally acquire the authority of a nearby human terminal.

Illustrative commands are:

```text
gsv route endpoints
gsv route bindings
gsv route bind <surface-handle> <pid>
gsv route unbind <surface-handle>
gsv route new <surface-handle>
gsv route edges
gsv route connect <source-pid> <destination-handle-or-pid>
gsv route pause <edge-handle>
gsv route resume <edge-handle>
gsv route disconnect <edge-handle>
gsv route deliveries [--failed]
gsv route cancel <delivery-handle>
```

Those are external Rust CLI spellings. The Kernel-native shell exposes the
same subcommands as `route ...` (without launching `gsv`) and forwards them
through the current Process context.

Both frontends print opaque handles, Process labels/PIDs, state, and bounded
display metadata. Neither prints adapter account ids, actor ids, provider
surface ids, thread ids, provider message ids, or client instance ids. The
external Rust CLI is always authorized through its connection identity. The
Kernel-native command is always authorized through its Process context and
triggers `route.*` capability plus exact pending-HIL policy.

Illustrative Kernel calls are:

```ts
// Human-only bootstrap for the caller's own client installation and slot.
"route.surface.open"({ instanceId, slot, label? })
  -> { endpoint: RouteEndpoint; binding: InteractiveBinding };

// Surface-aware interactive admission. inputId is stable across retries.
"route.surface.send"({
  surfaceEndpointId,
  inputId,
  text,
  media?,
  selection?: { processEndpointId, expectedRevision }
}) -> { pid: string; runId: string; queued: boolean };

"route.endpoint.list"({ kind?, state? })
  -> { endpoints: RouteEndpoint[] };
"route.binding.list"({})
  -> { bindings: InteractiveBinding[] };

// All mutations use observed revisions and idempotent operation ids.
"route.binding.set"({
  surfaceEndpointId, processEndpointId, expectedRevision, operationId
}) -> { binding: InteractiveBinding };
"route.binding.unbind"({
  surfaceEndpointId, expectedRevision, operationId
}) -> { binding: InteractiveBinding };
"route.binding.spawn"({
  surfaceEndpointId, spawn, expectedRevision, operationId
}) -> { process: ProcSpawnResult; binding: InteractiveBinding };

"route.edge.create"({ source, destination, operationId })
  -> { edge: OutputEdge };
"route.edge.update"({ edgeId, state, expectedRevision, operationId })
  -> { edge: OutputEdge };
"route.edge.delete"({ edgeId, expectedRevision, operationId })
  -> { edge: OutputEdge };

"route.delivery.list"({ edgeId?, state?, cursor? })
  -> { deliveries: RedactedRouteDelivery[]; cursor?: string };
"route.delivery.cancel"({ deliveryId, expectedRevision, operationId })
  -> { delivery: RedactedRouteDelivery };

// Connection id and uid come from authenticated request context.
"route.attach"({ pid, bindingFence? })
  -> { attachmentId: string; pid: string };
"route.detach"({ attachmentId }) -> { detached: boolean };
```

The Kernel never accepts a caller-supplied uid, connection id, internal adapter
address, or provider id. Mutations use both compare-and-swap revisions and an
operation ledger: a lost response can return the stored result, while reuse of
an operation id with different canonical arguments is a conflict.

Useful redacted signals are limited to invalidation:

- `route.binding.changed { binding, reason }` to authorized owner clients;
- `route.edge.changed { edge, reason }` to authorized owner clients;
- `route.delivery.changed { delivery }` for a material receipt transition;
- `route.attachment.closed { attachmentId, pid, reason }` to the affected
  connection.

Existing `proc.run.*`, `proc.changed`, and HIL signals keep their current
meaning and PID/run-id correlation. Output delivery does not replay Process
stream signals through the graph.

## Durable spawn-and-bind saga

“New chat” is one Kernel-coordinated `route.binding.spawn` operation. Clients
must not sequence `proc.spawn` and `route.binding.set` themselves because no
transaction spans the Kernel and Process Durable Objects.

The Kernel persists an operation record before contacting a Process. It is
scoped by owner uid and `operationId` and contains the surface handle, expected
binding revision, canonical spawn-request digest, reserved PID, state,
timestamps, and eventual redacted result. The digest contains no prompt or
credential material.

1. Authorize the caller, complete exact HIL for a Process caller, validate the
   endpoint and observed binding revision, reserve a PID, and persist `staged`.
2. Initialize the reserved Process through the Process-owned identity boundary.
   It is not yet in the public registry and cannot receive normal input.
3. Record `initialized`. In one Kernel transaction, recheck the operation and
   binding fence, publish the Process registry/endpoint, advance the binding
   revision, and mark the operation `committed`.
4. Return the stored result. A retry after a lost response returns the same
   Process and binding.

If initialization fails or the binding revision changes before publication,
the operation enters rollback, the staged Process is torn down, and the old
binding remains. Cancellation before publication requests rollback;
cancellation racing a committed publication reconciles to the committed result
and never kills the published child. A Kernel alarm reconciles aged
nonterminal operations and orphaned staged Process state. Terminal operation
records remain for a bounded retry horizon.

The first message after spawn resumes the same `route.surface.send` ingress
operation after its binding step; a client does not follow spawn with a direct
`proc.send`. The Kernel allocates its run id and persists its exact reply route
before media transfer or Process admission.

## Kernel and Process ownership

The design deliberately keeps cross-boundary responsibility explicit:

| Component | Owns |
|---|---|
| Kernel DO | Endpoint catalog, opaque/raw mapping, surface admission and exact reply-route ordering, bindings, graph/grant validation, edges, operation ledgers, delivery planning, trace budgets, receipt state, authorization, reconciliation alarms |
| Source Process DO | Atomic assistant-history/output-outbox commit, stable output event id, immutable payload read, retry alarm, payload/media lease until Kernel acknowledgement and transfer claims |
| Destination Process DO | Idempotent inbound delivery claim, destination-scoped media, history append, queue admission, destination run lifecycle |
| Adapter account DO | Provider address/protocol, outbound idempotency ledger, retry/ambiguity rules, provider delivery |
| Client | Connection lifecycle, live attachment, local display; never durable delivery merely because a socket write succeeded |

The Kernel coordinates sagas but does not move Process state or adapter quirks
into the control plane. Every cross-DO request has a stable operation or
delivery id, a canonical argument fingerprint, one owner, and an explicit
terminal outcome. Alarm reconciliation consults the owning DO's durable claim
before retrying. Potentially large or binary payloads use body streams with one
consumer and one terminal outcome; graph frames carry only bounded metadata.

## Migration and implementation gates

Implementation requires versioned Kernel and Process migrations; this proposal
does not authorize ad hoc store-constructor schema changes.

The existing actor/thread-scoped adapter `surface_routes` data can seed opaque
surface endpoints and revision-one interactive bindings only when its owner
identity link and target Process are valid. Unprovable ownership is discarded,
not guessed. The exact internal tuple stays Kernel-internal. Current
`run_routes` must not be merged into durable graph edges: their exact per-run
lifecycle and destination snapshot remain a separate contract.

The current public `InteractionOrigin` embeds connection ids and raw adapter,
account, actor, surface, thread, message, device, schedule, and reply-to data in
Process history. The graph cutover must replace that public SDK/history shape
with the redacted `InteractionOrigin` proposed here. Live SQLite history and R2
archives require different migration paths.

For **active Process SQLite history**, a versioned schema migration adds a v2
origin representation and local migration checkpoint. Before that Process
serves live history or resumes work, a bounded, resumable data pass converts
legacy rows transactionally, assigns a stable opaque `legacy_origin_...` id,
retains only safe bounded display/reply semantics, and clears the legacy raw
origin after its batch commits. It neither needs nor may reconstruct a
deliverable endpoint from old history.

For **R2 compacted segments and killed-Process archives**, a SQLite migration
cannot rewrite the object bytes and the design must not claim that it did.
Every archive reader, history export, fork/import, restore, and model-context
hydration path parses legacy records internally and projects only redacted v2
origins before returning or admitting them. Unrecognized origins become
`local`/unknown; raw legacy origin JSON never crosses the public boundary.

An optional background archive migration may reduce retained raw data, but it
is copy-on-write: write and verify a new redacted object, then atomically swap a
durable owning metadata pointer where one exists. Never overwrite an immutable
R2 object in place or delete the old object while an archive path, fork export,
or other durable reference can still name it. Killed archives without a
mutable owning pointer remain protected by mandatory read-time redaction until
their normal retention/deletion lifecycle; this proposal does not invent an
atomic pointer swap for them.

Exact adapter addresses needed by active replies remain only in Kernel
`run_routes` or adapter ledgers and are unaffected by either history path.
Records whose raw origin cannot be safely interpreted are never guessed into a
deliverable address. New surface admission always supplies the real opaque
endpoint-origin handle, so `legacy_origin_...` exists only for non-deliverable
historical provenance.

This is a hard public-protocol cutover across `packages/gsv`, Gateway Process
frames/storage/context formatting, web/native/CLI consumers, and history
exports. Do not retain a public union that sometimes returns raw legacy origin
fields, and do not dual-write raw and redacted origin into new history. Upgrade
tests must separately prove active SQLite conversion, read-time redaction of
unchanged compacted and killed archives, copy-on-write pointer-swap crashes,
and that every new public result is redacted.

Native, web, and TTY bindings must not be inferred from `proc.list` recency. A
client explicitly opens a surface and chooses an existing PID or invokes the
spawn-and-bind saga. Adapter routing, settings UIs, and CLIs should move to the
same Kernel service in one deliberate cutover; do not preserve indefinite
dual-write paths.

Before runtime rollout, tests must cover at least:

- raw adapter/provider identity preservation internally and non-exposure from
  every generic result, signal, approval, receipt, and log;
- owner, actor, shared-surface, capability, and HIL isolation;
- exact reply stability across bind, unbind, edge edits, disconnect, reset, and
  Process kill races;
- Process-output commit before graph planning and idempotent retries at every
  Kernel/Process/adapter saga crash point;
- source output/history atomicity, outbox alarm recovery, immutable output
  reads, zero-edge acknowledgement, and media-lease release fencing;
- Process-to-Process admission deduplication, provenance, capability isolation,
  media copy cleanup, and late completion fencing;
- static self/indirect-cycle rejection, output/delivery retry deduplication,
  path-local ancestry suppression, legitimate fan-in, trace TTL/depth/delivery
  budgets, and adapter self-echo handling;
- fan-out limits, queue backpressure, ordering, edge auto-pause, cancellation
  before/after admission, and bounded receipt retention;
- monotonic tombstones across unbind, edge deletion, endpoint retirement,
  Process kill, adapter unlink, and reauthorization;
- spawn-and-bind operation conflicts, cancellation races, alarm recovery, and
  orphaned staged-Process cleanup;
- `route.surface.send` retries and crashes before/after binding resolution, run
  route persistence, media staging, Process admission, and cancellation;
- invocation-scoped Process selection without binding mutation, selection-fence
  races, canonical text/media digest conflicts, reordered bodies, and finalized
  staging-manifest verification;
- matching media retries against accepted, terminal, concurrent-live, expired,
  and abandoned ingress claims, including attempt takeover and fenced late
  chunks/finalization into the stable staging identity;
- separation from `proc.ipc.send` and bounded `proc.ipc.call`, including exact
  call reply/timeout delivery to a superseded or aborted source run;
- trace seed/inheritance for surface send, direct `proc.send`, IPC send/call,
  scheduler/background roots, graph delivery, and IPC reply admissions, without
  coupling the IPC call ledger to output-edge receipts;
- edge creator/audit/HIL attribution and revocation before/after destination
  admission, plus autonomous delivery when the creator is offline or later
  loses mutation capability while the owner grant remains enabled;
- active SQLite raw-origin migration, read-time redaction for unchanged R2
  compacted/killed archives, copy-on-write archive rewrite/pointer-swap races,
  and the absence of provider/connection fields in every new SDK, history,
  context, signal, and export shape;
- preservation of `originEventId` and exact reply surface identity through
  branching, route cleanup, endpoint retirement, output plans, and tombstones,
  plus suppression only when outbox `runId` matches immutable
  `exactReplyRunId`;
- client attachment restoration after hibernation, plus explicit rejection of
  durable native/TTY sinks until a real durable inbox exists.

The runtime is not complete when only the CLI or graph tables exist. A usable
cutover requires the Kernel graph service, Process source/destination receipt
contracts, adapter delivery integration, graph authorization/HIL, loop and
backpressure enforcement, client management UI, and cross-boundary tests.

## Related contracts

- [Adapter model](adapter-model.md)
- [Routing reference](../reference/routing.md)
- [Syscall reference](../reference/syscalls.md)
- [WebSocket protocol](../reference/websocket-protocol.md)
