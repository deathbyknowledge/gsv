# Universal Interaction Surface Bindings (Proposal)

Status: design only. This document proposes a Kernel-owned contract; it does
not describe an implemented protocol.

GSV has one durable conversation primitive: the process. An interaction
surface selects which process receives its next input, but that selection must
not also decide where every future process output is delivered. The design
therefore keeps three routes separate.

| Route | Lifetime | Meaning |
|---|---|---|
| Surface binding | Durable, including unbound tombstones | Which interactive process a surface selects for new input |
| Run reply route | One run, through its terminal delivery outcome | Where that exact run replies |
| Live attachment | One authenticated client connection | Which process a connected UI observes |

The Kernel owns all three. A PID remains the only process and history identity;
none of these routes introduces a second conversation id.

## Invariants

- A binding is scoped to the owning uid and can name only a live interactive
  process owned by that uid.
- Input resolves a binding once. Rebinding affects later input, never an
  already admitted or queued run.
- Every admitted run keeps its exact `runId`, PID, owner, and reply origin. Its
  reply route is installed before the Process can emit a signal.
- A live attachment is pinned to an exact PID. It does not silently follow a
  later binding change.
- Binding revisions never move backwards or reset. Unbind, process teardown,
  and surface retirement preserve an incremented tombstone so stale
  compare-and-swap requests cannot pass through an ABA cycle.
- Raw adapter, account, actor, surface, thread, and provider identifiers remain
  inside the Kernel and adapter boundary. Generic clients and processes use an
  owner-authorized opaque surface handle.
- `proc.run.*` signals retain their PID and `runId`; clients must not infer
  either from the current surface binding.
- HIL remains an owner-scoped security alert: every connected client for the
  owning user may see and answer it, while an adapter approval still requires
  the exact pending request token.

## Internal identity and public handles

The durable store generalizes the current actor-scoped `surface_routes` table.
The Kernel keeps the normalized transport address and its public identity in
separate fields:

```ts
// Kernel-internal only. This value never crosses a generic syscall or signal.
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
      instanceId: string;
      slot: string;
    };

type StoredSurfaceBinding = {
  uid: number;
  surfaceHandle: string;
  address: InternalSurfaceAddress;
  pid: string | null;
  revision: number;
  retired: boolean;
  updatedAt: number;
  updatedByUid: number;
};
```

The Kernel assigns each authorized surface a stable random opaque handle such
as `surface_...`. A handle is a selector, not a credential: every lookup still
checks the authenticated caller's owner uid. It cannot be decoded into a
provider or platform identifier.

Generic APIs return only a redacted view:

```ts
type InteractionSurface = {
  surfaceId: string; // Opaque owner-scoped handle.
  kind: "client" | "messaging";
  display: {
    name: string;
    context?: string;
  };
  binding: {
    state: "bound" | "unbound" | "retired";
    pid: string | null;
    revision: number;
    updatedAt: number;
  };
};
```

Display text is non-authoritative, bounded metadata suitable for choosing a
surface, for example “Native · Main” or “WhatsApp · Design group.” It is never
used to reconstruct an address or authorize delivery. Adapter surfaces become
visible only after joining their exact internal tuple to a live identity link
for the owner. Processes and clients never submit or receive that tuple.

Client `instanceId` is a locally persisted identifier for an app installation
or CLI profile, and `slot` identifies a window or named terminal chat. They are
used only by the authenticated human bootstrap call that opens that client's
own surface. Neither is a credential, and neither is returned when another
caller lists surfaces.

## Semantics by surface

### Adapters

Adapter ingress keeps its current normalized, actor-scoped identity. Each
authorized inbound message resolves the internal address to an opaque handle,
then resolves the handle's binding and creates the exact adapter run reply
route before admission. `/use <pid>` changes the binding; `/use personal` and
`/use <agent>` use the durable spawn-and-bind operation. An absent or stale
binding may use the same operation to create and bind a new personal-agent
process under the durable ingress receipt.

Adapters do not create live attachments. Their platform connection, typing
state, provider reply id, retry ledger, and automatic final delivery remain
owned by the adapter and the run reply route. The generic surface store sees
only the opaque handle; the adapter service and Kernel retain the address
needed for ingress and delivery.

### Native and other graphical clients

A native installation persists an `instanceId`, and each independent chat
window uses a stable slot. An authenticated human connection calls
`surface.open` with those values to resolve or create its own opaque handle. It
then resolves the binding and attaches to the exact returned PID. Choosing
another existing process binds it with a revision check and then replaces the
connection's attachment. Reconnect resolves the same durable binding instead
of choosing the most recently active process.

The installation `instanceId` is not the WebSocket `sys.connect.client.id`.
Each window keeps a separate slot-qualified connection client id, with a live
window/session component. Reconnects for that same window reuse it so the old
socket is superseded, while different windows or concurrent terminal
invocations use different connection client ids and can coexist even when they
share one binding. The Kernel treats that id as connection lifecycle metadata;
it never parses it to recover the installation or surface key.

An attachment lets the client observe live signals for its selected process;
history remains authoritative for reconnect and gap recovery. A binding-change
signal may offer the user the new selection, but must not move a window during
an active or queued run.

### TTY and native CLI

`gsv chat` uses a persisted CLI `instanceId` and a default slot;
`--surface NAME` selects another durable slot. Each invocation attaches to the
resolved PID, but the TTY continues to render output only for the exact run it
is awaiting. This preserves the current early-signal buffering and exact-run
filtering behavior.

An explicit `--pid` is an invocation-scoped attachment and does not rewrite a
durable binding unless the user also asks to bind it. A bare session with no
binding uses durable spawn-and-bind. Multiple terminals may share a named
binding, but each live attachment stays pinned until that terminal explicitly
switches. Connection ids remain ephemeral and are never durable surface keys.

The native CLI exposes the same generic contract through commands such as
`gsv surface list`, `gsv surface use <surface-id> <pid>`, and
`gsv surface new <surface-id>`. It prints display metadata and opaque handles,
never transport identifiers. A human CLI connection acts with the human's
authority. The same CLI invoked by a Process acts with that Process's identity
and cannot borrow cached human credentials.

### Agent-directed changes

An agent can therefore respond to “start a new chat” or “move WhatsApp to the
research process” without adding another model-facing tool. It discovers the
owner's authorized opaque handles through the CLI from Shell or CodeMode, then
requests `surface.spawn` or `surface.bind` beneath that fixed interface.

Process-originated reads and mutations require the corresponding `surface.*`
capability and resolve ownership through the Process owner, not its run-as uid.
Every Process-originated bind, unbind, or spawn also requires an exact,
single-use HIL decision. The approval describes the surface using its bounded
display metadata and the target process or new-chat action; it never reveals
the internal address. Devices and schedulers cannot mutate bindings. A future
persistent delegation policy must be explicit and narrowly scoped rather than
being inferred from an “always allow” response.

The Kernel derives the requesting PID and run from the authenticated Process
context; neither the agent nor the CLI supplies them. The mutation is suspended
before side effects while the Process owns the pending HIL request. Denial or
cancellation returns a normal syscall failure to the waiting CLI or CodeMode
call, and a stale approval cannot resume a newer request.

The current run's reply route remains unchanged when its Process rebinds the
originating surface. The user therefore still receives the answer confirming
the change, while the next input on that surface goes to the newly selected
process.

## Proposed syscall and signal contract

Generic calls use only opaque handles. The Kernel supplies the authenticated
owner uid; it never accepts a caller-supplied uid, connection id, or adapter
address. Trusted adapter ingress uses the same internal binding service after
establishing its address through service identity and the exact actor link.

```ts
// Human-client bootstrap for that client's own installation and slot.
"surface.open"({ instanceId, slot, label? })
  -> { surface: InteractionSurface };

// Owner-authorized inventory and exact lookup; no transport ids are returned.
"surface.list"({ kind? }) -> { surfaces: InteractionSurface[] };
"surface.get"({ surfaceId }) -> { surface: InteractionSurface };

// Mutations compare the required observed revision.
"surface.bind"({ surfaceId, pid, expectedRevision })
  -> { surface: InteractionSurface };
"surface.unbind"({ surfaceId, expectedRevision })
  -> { surface: InteractionSurface };

// operationId makes a retried user action return the same child and binding.
// spawn excludes prompt; the first message follows normal proc.send admission.
"surface.spawn"({ surfaceId, spawn, expectedRevision, operationId })
  -> { process: ProcSpawnResult; surface: InteractionSurface };

// connectionId and uid come from the authenticated request context.
"surface.attach"({ pid, binding?: { surfaceId, revision } })
  -> { attachmentId: string; pid: string };
"surface.detach"({ attachmentId }) -> { detached: boolean };
```

`surface.open` is human-client-only. `surface.list` and `surface.get` apply the
same owner and capability checks to Process callers; adapter surfaces appear
only as opaque, authorized entries. Mutations reject retired surfaces,
foreign/non-interactive PIDs, stale revisions, and a Process request without a
resolved HIL decision.

If a bind or unbind response is lost, the caller reconciles with `surface.get`;
it does not blindly repeat a mutation with the stale revision. Spawn uses the
stronger operation ledger below because it owns a cross-DO lifecycle.

`surface.attach` rejects a supplied binding fence if it no longer resolves to
the PID. Supplying only a PID supports deliberate one-session attachment such
as TTY `--pid`. Attachments are connection-local observation state, not durable
delivery destinations. To survive Kernel Durable Object hibernation, the
bounded `{ attachmentId, pid }` set is serialized in the hibernation-restored
connection state alongside identity and client metadata. It is rebuilt with
the live connection index on wake and removed on disconnect or supersession;
it is never stored as a SQLite delivery route.

Two new signals are sufficient:

- `surface.binding.changed { surface, reason }` carries the redacted
  `InteractionSurface` view as an owner-only invalidation after bind, unbind,
  process teardown, or retirement.
- `surface.attachment.closed { attachmentId, pid, reason }` goes only to the
  affected connection when a process exits, a client is superseded, or the
  Kernel revokes the attachment.

Existing `proc.run.*`, `proc.changed`, and HIL signals retain their meanings.
Ordinary live signals go to the exact connection reply route and any
authenticated attachments for that PID, with duplicate delivery to the same
connection suppressed. If no reply route survives, attachments can still
observe the run; otherwise durable history is the recovery path. This replaces
an owner-wide fallback for ordinary output, but not the owner-wide HIL alert.

## Durable “new chat” orchestration

“New chat” calls `surface.spawn`; clients must not sequence `proc.spawn` and
`surface.bind` themselves. This is a durable Kernel-coordinated saga, not an
atomic transaction across the Kernel and Process Durable Objects.

The Kernel stores a `surface_operations` record before contacting a Process.
It is scoped by owner uid and `operationId` and contains the surface handle,
expected revision, a canonical digest of the spawn request, a reserved PID,
state, timestamps, and the eventual redacted result. The digest contains no
prompt or credential material. Reusing an operation id with a different
surface, revision, or request digest returns a conflict. A retry checks this
ledger before comparing the now-stale binding revision, so a committed
operation returns its original child and binding.

The saga proceeds as follows:

1. Authorize the caller, resolve HIL when the caller is a Process, validate the
   handle and observed revision, reserve a PID, and persist `staged`.
2. Initialize the reserved Process through the Process-owned identity
   boundary. The staged PID is not yet present in the public process registry
   and cannot receive normal input.
3. Record `initialized`, then in one Kernel SQLite transaction recheck the
   operation and binding revision, publish the process registry row, advance
   the binding revision to the new PID, and mark the operation `committed`.
4. Return the stored result. A retry after a lost response returns that same
   result rather than creating another process.

If initialization fails or the binding revision changes before publication,
the operation enters rollback, the staged Process is torn down, and the old
binding remains unchanged. Cancellation before publication requests rollback;
cancellation racing a committed publication reconciles to the committed result
and never kills the published child. A Kernel alarm reconciles aged nonterminal
operations, verifies initialized Process identity before resuming, and removes
orphaned staged Process state. Compact terminal operation records remain for a
bounded retry horizon; clients must generate operation ids that are never
reused after that horizon.

For every surface, the subsequent first message still uses `proc.send`. The
Kernel preallocates its `runId` and persists the exact reply route before
Process admission, so even immediate stream or HIL signals have a route.

## Revisions, lifecycle, and cancellation

An unseen surface begins with revision zero and an unbound state. Every
successful bind or unbind increments the revision. Rows are not deleted during
normal lifecycle operations:

- `surface.unbind` writes an incremented unbound tombstone with `pid = null`.
- `proc.kill` atomically converts every binding to that PID into incremented
  unbound tombstones, closes live attachments, and emits redacted binding and
  attachment invalidations.
- Removing an adapter account or identity link retires the corresponding
  surface identity and advances its tombstone revision. A retired handle is not
  reassigned to another address.
- Reauthorizing the same internal address after retirement creates a new
  surface identity and handle. The old handle remains a terminal retired
  tombstone and never resets to revision zero.

This preserves compare-and-swap safety across bind → unbind → bind and
bind → process kill → bind sequences. Revision overflow is an explicit fatal
invariant rather than a wraparound.

Disconnect or connection supersession removes attachments and connection reply
routes, but preserves bindings, processes, queues, and history; it does not
abort a run. `proc.abort` stops only the selected run. `proc.reset` clears run
routes and history as today but preserves the binding to the same PID.
Rebinding or unbinding never cancels work, and adapter reply routes remain
durable through their terminal delivery or retry outcome even if their surface
is rebound meanwhile.

## Authorization summary

- Authenticated human connections may list and mutate their owner-scoped
  surfaces and attach to same-owner interactive processes.
- Process callers need the corresponding capability, must share the surface
  owner, and require an exact single-use HIL decision for every mutation.
- Adapter mutations occur only inside authenticated adapter ingress after the
  actor link and exact internal surface have been checked.
- Devices and schedulers cannot mutate bindings. Root administration, if
  exposed, is an explicit separate authority path.
- Opaque handles, display labels, revisions, instance ids, slots, and
  attachment ids are selectors or audit metadata, never proof of identity or
  destination authority.
- No `surface.*` request accepts raw adapter, provider, account, actor, thread,
  or connection identifiers.

## Migration and rollout

Add a versioned Kernel migration for surface identities, monotonic bindings,
and the spawn-operation ledger. Current actor/thread-scoped adapter rows retain
their exact tuple only in the Kernel-internal address columns. Rows with a
valid owner identity link receive a stable opaque handle. A row selecting a
live same-owner interactive process becomes revision-one bound state; a stale
target becomes a revision-one unbound tombstone. Rows whose ownership cannot
be proved are discarded rather than guessed.

Remove the old table in the same cutover and do not dual-write indefinitely.
The existing `run_routes` table is not migrated or merged because its lifecycle
and purpose are different. The operation ledger starts empty.

Do not synthesize native or TTY bindings from `proc.list` recency. An upgraded
human client may call `surface.open` and explicitly bind the exact PID it
already selected; an explicit environment or `--pid` override may attach to
that PID without binding. Otherwise the client asks the user to choose or
performs durable “new chat.” Roll out the Gateway contract before clients and
feature-detect it during the transition.

Migration and lifecycle tests must cover:

- exact internal adapter-key preservation without exposure through generic
  results or signals;
- actor isolation in a shared provider surface and foreign-handle rejection;
- stale and foreign PID rejection;
- monotonic tombstones across unbind, kill, retirement, and reauthorization;
- multiple slot-qualified connections and attachment rehydration after
  hibernation;
- operation-id digest conflicts, retries at every saga crash point, cancellation
  races, and orphaned staged-Process cleanup;
- capability enforcement for Process-originated reads, plus exact HIL
  correlation for bind, unbind, and spawn requests.

## Why this is not a generic output sink

A surface binding answers only: “which process receives the next input from
here?” One process may be bound from several surfaces, and rebinding is common.
Sending every process answer to every bound surface would leak replies across
contexts, duplicate adapter messages, and revive stale provider destinations.

Automatic output therefore follows the exact run reply route captured at
admission. Live attachments are authenticated observation subscriptions, not
durable delivery addresses. Additional or scheduled delivery continues to use
the separately authorized message-destination contract. No binding authorizes
fan-out, cross-channel delivery, or arbitrary process output replication.

## Related contracts

- [Adapter model](adapter-model.md)
- [Routing reference](../reference/routing.md)
- [Syscall reference](../reference/syscalls.md)
- [WebSocket protocol](../reference/websocket-protocol.md)
