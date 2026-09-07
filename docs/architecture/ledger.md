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
| `detail` | The argument a person recognizes the call by, one line, at most 200 characters |
| `outcome` | `ok`, `failed`, `denied`, or `cancelled`; null while the call is in flight |
| `durationMs` | From dispatch to response |
| `tokens`, `costNanoUsd` | From `message.usage` on an `ai.text.generate` result: its `totalTokens`, and `cost.total` in USD converted to nano-USD |

`detail` is redacted at write time and only ever holds: for a shell command,
its command word and first argument, and nothing from the first content flag
onward (`--message`, `-m`, `-H`, `--header`, `--data`, `-d`, `--body`,
`--cookie`, `--user`, `--token`, `--password`); assignments such as
`KEY=value` or `--flag=value` are dropped wherever they sit, nothing after
`echo` or `printf` is kept, `user:password@` is removed from any token, and a
URL, with or without a scheme, ends before its query or fragment. A script
run through codemode is described as `script (N lines)` and never by its
text. For other calls the detail is a path, a URL's host only, a model id,
a process label, an adapter name, a config key. Request ids,
targets, process and run ids are capped at 128 characters and the detail at
200, truncation marked, whatever the caller sent. Bodies, message text, search
queries, prompt content, tokens, and credentials never enter the ledger, so a
segment is safe
to hand to a client as it is.

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

The window is bounded to 5,000 lines or 24 hours, whichever comes first.
Exactly one rotation task is pending at any time, keyed by its callback and
payload: a row-bound crossing moves the pending task nearer, never adds to it,
and the task re-arms itself once when it runs, daily, or a minute later while
the window is still over its bound, as after a failed write. The running task
still has its row while it runs, so the re-arm names it and replaces it rather
than mistaking it for a pending one.

## Segments

Rotation captures the oldest lines in sequence order, up to 2,000 at a time,
stopping at the first line still open within the window age, writes them
as one immutable object under `ledger/<seq>.jsonl` in the installation's R2
storage, one JSON line per ledger line, and only then, in one transaction,
deletes exactly those sequence numbers from the window and inserts the
segment's index entry into `ledger_segments`: sequence range, first and last
timestamp, row count, bytes, and the sets of owner uids, process ids, and
targets present. A set with more than 64 distinct values is stored as
"unknown", and a read then opens the segment rather than trusting the index. A line that completes while the object write is in flight is
untouched and rotates next time. Lines still open after the window age are
closed as `cancelled` on the way out. A failed write retries on the next alarm
and prunes nothing. A segment stays well under 1.5 MB.

An open line holds the boundary until it closes or ages out, so every segment
is a contiguous range below everything left in the window and a read is
newest-first across the two. The index is what keeps reads cheap: a query filtered by owner,
process, or place skips every segment whose sets cannot contain a match.

## Retention

Segments expire by an R2 lifecycle rule on the `ledger/` prefix. Set it on the
bucket, 90 days to start:

```
wrangler r2 bucket lifecycle add gsv-storage --prefix "ledger/" --expire-days 90
```

Lifecycle rules are bucket configuration, not Worker configuration, so the
deployment does not declare them. The alarm drops index entries whose object
is gone.

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
the ledger without polling.

## Cost

One insert per dispatch and one count per hundred, in the transaction the
Kernel already holds, and one update on completion. Storage in the Kernel is
the window plus an index entry per segment, a few hundred bytes each. If the
write ever shows in Kernel latency, the same rows can move to a separate actor
without changing the wire.
