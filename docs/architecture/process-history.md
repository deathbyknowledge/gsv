# Process History

Process SQLite owns execution history. Canonical Conversations own committed
human-facing messages independently of Process reset, compaction, or replacement.
The SDK defines the history records and event payload schemas in
`packages/gsv/src/protocol/history.ts` and `events.ts`.

| Kind | Data |
|---|---|
| `message` | Incoming or confirmed outgoing text, media, origin, and Conversation references |
| `note` | Model text and thinking blocks |
| `call` | Call identity, tool, syscall, arguments, resolved target, and run identity |
| `result` | Call identity, outcome, typed output, errors, media, and resources |
| `event` | Registered event kind, payload, severity, and audience |

An original message and its companion records form one ordered group. A model
turn can contain a note and several calls; a later Conversation commit or media
failure can add another member to that older group. Paging and synchronization
never split a group. The stable live member key is
`(generation, messageId, index)`: inferred legacy members may share a storage `id`.

## Rendering boundaries

Storage normalizes supported legacy rows once at the read boundary. It retains
source bytes that inferred records cannot reconstruct, including JSON whitespace
and historical tool-error variants. Migration does not rewrite those histories.
New writers persist typed payloads alongside compatibility prose during this
transition; older clients can still request the original wire shape.

`process/history/model-renderer.ts` owns provider-message construction, origin
annotations, media hydration order, and tool-result ordering. Event and media
renderers own their text. Golden fixtures captured before extraction guard exact
provider content and metadata, including missing media and shared hydration
budgets. A person-only event contributes no provider message and cannot change
origin annotations or consume model context.
Model-facing events start with `[GSV EVENT]` before any origin annotations.
Scheduled events name an explicit reply target once in their body. Without one,
they retain ordinary run destination annotations and do not redirect an active run.
Target connection text names only the target ID and the connection change;
display name, platform, and version remain in the structured payload.

Responsibility events retain their complete ledger transition and an optional
`contextFields` projection. Process selects those fields when it appends the
event: changed values plus any current fields the model has not yet seen.
The starting ledger contributes only fields actually rendered through `{{r12y}}`;
its compact view can omit records and details. Prior model-visible events also
contribute their rendered fields, including imported history. Explicit field
clears remain visible. The selected projection survives reload and archive reads
without consulting a later ledger state. History import introduces the first
retained occurrence of each responsibility before rendering subsequent deltas,
because the source context baseline may not accompany an exported segment.
Older events without a field projection render their present record fields;
older prompt epochs without rendering metadata do not imply that the baseline
was shown. This can introduce a record again once during an upgrade.

`process/history/compaction-renderer.ts` renders typed JSONL for summarization.
The bounded transcript preserves head and tail records and explicitly marks
omission and oversized payloads. Person-only events are excluded from summary
input as well. Prefix selection keeps storage coordinates while estimating only
the corresponding provider messages; calls and their results remain together.
The replacement is a `history.compacted` event with summary and segment identity.

Web, Desktop, CLI, and the native agent shell switch on record kind. They use
explicit call routing, result outcomes, and event severity instead of inferring
meaning from prose or JSON-looking strings. Zen presents committed Conversation
messages with Process working folded beneath them. A new client explicitly
reports an unsupported history format when connected to an older gateway.

## Live synchronization

Request `proc.history` with `format: 2`. The successful result retains the
existing messages and status fields and adds `records`, `historyRevision`,
`historyGeneration`, `historyResetRevision`, `reset`, `hasMore`, and, for a head
snapshot or delta, an opaque `cursor`.

1. Load a bounded tail snapshot with `{ format: 2, tail: true }`.
2. On a history change, request `{ format: 2, since: cursor }`. On reconnect,
   resume with the cursor or reload the tail snapshot, as the web client does.
3. Replace each returned parent group in full, preserving other loaded groups.
4. Continue with the returned cursor while `hasMore` is true.
5. When `reset` is true, replace the loaded history with the returned tail
   snapshot and restart older-page loading from its boundaries.

Schema 15 adds a revision to each parent row. Append, companion, and media
mutations advance the durable revision and update the owning parent. Delta pages
select groups by revision, then present them in history order. Compaction,
context-owned deletion, and reset advance a reset watermark; history generation
and monotonic revisions survive eviction. No per-change journal is required.

`since` requires format 2 and cannot be combined with offset, tail, before/after
paging, or status-only reads. Cursors are bound to a Process and versioned by the
implementation. Malformed, wrong-Process, and future cursors fail explicitly.

Historical before/after/offset pages and status-only reads never return a cursor.
A historical page can contain a newer revision without containing intervening
updates, so it must not advance head synchronization. Compare its generation and
reset watermark with the active snapshot before merging it; reload the tail if
they differ. `proc.changed` carries revision hints, but cursor reads recover
missed and coalesced signals.

## Archive reads

`proc.history.segment.read` also accepts `format: 2`. It returns typed records
alongside compatibility messages and has no live synchronization cursor.
Archived identities use stable ordinals within the immutable segment, computed
before paging. `sourceMessageId` retains an original message ID when available;
missing historical timestamps and result call IDs remain explicitly unknown.
This keeps supported old archives inspectable without inventing provenance or
weakening live-history identity requirements.

Removing compatibility prose, the old `messages` wire projection, and legacy
inference requires a later, explicit supported-upgrade policy.

## Registered target events

The first custom source is `target.connection`, registered in the SDK with its
payload schema, severity, default audience, and allowed audiences. A Process can
use its existing `signal.watch` capability to watch an accessible target:

```json
{
  "signal": "target.status",
  "targetId": "laptop",
  "key": "laptop-connection",
  "once": false,
  "audience": "person"
}
```

The source is an explicit `targetId`, and the only registered signal is
`target.status`. Watches default to audience `person`; `model` and `both`
explicitly admit model work. Existing watch TTL and one-shot semantics apply.
Generic process signal watches are retired: upgrade removes their registrations,
and delayed watched-signal frames are ignored. Historical `signal.watched`
records and their original model rendering remain supported.

The native Shell exposes the same primitive as `signal watch --json JSON` and
`signal unwatch --json JSON`. CodeMode can use its existing `shell()` helper.
The command validates the public syscall argument contract and delegates to the
same capability-checked Kernel handlers; it does not add a model tool.

The Kernel captures connection facts from its target registry, checks target
access and the watching Process's current capability, and uses an internal
`proc.event.deliver` request. Public callers cannot send that request, choose a
target identity in a machine signal, or register arbitrary payload shapes.
The managed installation work gate also applies before delivery. Watch revisions
fence updates and removal while an earlier delivery is in flight.

The Process writes a person-only notice and its bounded durable receipt
atomically, emits a history change, and allocates no run or queued work.
Model-visible audiences use the existing runtime event admission and wake path.
Duplicate deliveries are idempotent within retained receipts; events older than
the Process reset boundary are ignored. Raw history and client notices remain
available independently of the canonical Conversation.

Target connection notifications are best effort. SQL retains the watch, but this
first source does not introduce a durable transition replay queue or a separate
machine-rule runtime. Temporary Process lifecycle conflicts, service errors, and
RPC failures leave watches eligible for later transitions, including one-shot
watches that have not received a matching successful acknowledgment. The missed
transition is not replayed. Authorization failures, a gone Process, and invalid
acknowledgments still disable the watch.
