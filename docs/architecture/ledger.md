# The ledger

The ledger is the Kernel's record of what ran: one line per syscall that went
through the Kernel's peer dispatch, whoever asked for it. A process reading a
file on a machine, a human running a command from the prompt, an adapter
delivering a message: each is one line with who, where, the call, the argument
that matters, the outcome, and the duration. It answers "what happened on my
installation" without depending on any process's history, which is compacted
into memory over time and was never meant to be an audit trail.

Two paths are not recorded, on purpose: federation reads served to a contact
go straight into the transfer handler rather than through peer dispatch, and
model calls a Process makes through the inference service never cross the
Kernel at all. Both remain in their own records.

## What a line holds

| Field | Meaning |
| --- | --- |
| `seq` | Monotonic per installation |
| `timestamp` | When the call was dispatched |
| `principalKind`, `uid` | Who asked: the peer's principal kind and account |
| `pid`, `runId` | The process and run when a process asked |
| `target` | The place the call went to: a target id, or `gsv` for the cloud home |
| `call` | The syscall name |
| `args` | The call's arguments as sent, as JSON text, whole; cut at 16 KB with the cut marked |
| `outcome` | `ok`, `failed`, `denied`, or `cancelled`; null while the call is in flight |
| `durationMs` | From dispatch to response |
| `tokens`, `costNanoUsd` | From `message.usage` on an `ai.text.generate` result: its `totalTokens`, and `cost.total` in USD converted to nano-USD |

`args` is the input as sent, the whole of it, so the ledger answers "what
exactly ran" on its own. Nothing is interpreted or redacted: the ledger is the
owner's own record, read by that owner and by root, and it records a command
the way an endpoint sensor records a command line. A credential handed to a
syscall as an argument is recorded like anything else. A line is cut at 16 KB
of JSON text with the cut marked, which holds nearly every command, script and
message; `JSON.parse` failing on a line is how a reader knows it was cut.
Request ids, targets, process and run ids are capped at 128 characters,
whatever the caller sent.

## The window

Lines are written into `ledger_window` in the Kernel's own SQLite storage once
the grant decision is made (a denied call is recorded and closed as denied),
and completed with the outcome when the response is known: inline for local
calls, on the routed response for calls that went to a machine, and on expiry,
cancellation, or a refused registration otherwise. A routed call whose device
or origin disconnects mid-flight, or whose device answers something the Kernel
cannot decode, closes as `failed`; a call refused because its request was
already cancelled closes as `cancelled`. Every exit from the dispatch closes
its line. The dispatch path only inserts and, on the Kernel's first line and
every hundredth after, counts the window to keep a rotation armed; nothing
else runs inline.

The window is bounded to 5,000 lines. Age alone never rotates: a quiet
installation keeps every line in SQL and never writes a segment, so segments
are always full and a read of a quiet history never leaves the Kernel. The
daily task does the housekeeping that age does call for: a line still open
after 24 hours closes as `cancelled` in place, and a line older than the
retention period is deleted from the window, the same 90 days a segment
gets. Exactly one rotation task is pending at any time, keyed
by its callback and payload: a row-bound crossing moves the pending task
nearer, never adds to it, and the task re-arms itself once when it runs,
daily, or a minute later while the window is still over its bound, as after a
failed write. The running task
still has its row while it runs, so the re-arm names it and replaces it rather
than mistaking it for a pending one.

## Segments

Rotation captures the oldest lines in sequence order, up to 2,000 lines or
4 MB at a time, stopping at the first line still open within the window age,
writes them
as one immutable object under `ledger/<seq>.jsonl` in the installation's R2
storage, one JSON line per ledger line, and only then, in one transaction,
deletes exactly those sequence numbers from the window and inserts the
segment's index entry into `ledger_segments`: sequence range, first and last
timestamp, row count, bytes, and the sets of owner uids, process ids, and
targets present. A set with more than 64 distinct values is stored as
"unknown", and a read then opens the segment rather than trusting the index. A line that completes while the object write is in flight is
untouched and rotates next time. Lines still open after the window age are
closed as `cancelled` on the way out. A failed write retries on the next alarm
and prunes nothing. A segment stays under 4 MB, so a read that holds a few
of them stays small.

An open line holds the boundary until it closes or ages out, so every segment
is a contiguous range below everything left in the window and a read is
newest-first across the two. The index is what keeps reads cheap: a query filtered by owner,
process, or place skips every segment whose sets cannot contain a match.

## Retention

The Kernel keeps the promise itself. The daily task deletes every segment whose
newest line is past 90 days, object first and then its index entry, a bounded
number per run, and deletes window lines past the same age, so retention holds
whether or not a line ever reached a segment. It also checks the oldest few
index entries against storage each run and drops any whose object is gone.

In the managed service a segment's physical key sits under the installation's
prefix, so a bucket lifecycle rule on `ledger/` would not reach it; a rule is
belt and braces there, not the mechanism. A self-hosted bucket can add one on
the `ledger/` prefix at the same age:

```
wrangler r2 bucket lifecycle add gsv-storage --prefix "ledger/" --expire-days 90
```

## Reading

`sys.ledger.list` returns lines newest first, never more than `limit`, paged
by an opaque cursor: the window first, filtered and limited in SQL, then
segments from newest to oldest, at most four per call, with the index narrowed
by the time bounds when the query has them and the last few segments read kept
parsed for the pages that continue inside them. A filtered read may return
fewer than `limit` lines with a cursor still set; that means "more may exist,
continue here".

The cursor makes a rotation between two pages harmless. Each page that read
the window records the newest segment that existed at the time and the lowest
window sequence it examined, so everything at or above that number had been
seen. A segment created after such a page holds lines that were in the window
then, and reading it skips exactly those and returns the rest; segments older
than the walk are read whole. A line is therefore neither lost nor repeated
across a rotation. Filters are
`pid`, `target`, `callPrefix`, `since`, and `until`; `limit` is at most 200.
Visibility is the rule `proc.list` uses: a caller sees the lines of the human
who owns them, and root sees every line. The `ledger.appended` signal, sent to
the owner's connections and to root's, coalesced to a few per second, carries
the newest sequence and the count since the last signal, so a surface can tail
the ledger without polling. A read of the ledger is recorded like any other
call but does not signal, so a surface that lists on every signal does not
chase itself.

## Cost

One insert per dispatch and one count per hundred, in the transaction the
Kernel already holds, and one update on completion. Storage in the Kernel is
the window plus an index entry per segment, a few hundred bytes each. If the
write ever shows in Kernel latency, the same rows can move to a separate actor
without changing the wire.
