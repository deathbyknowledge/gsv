# The ledger

The ledger is the Kernel's record of what ran: one line per dispatched syscall,
whoever asked for it. A process reading a file on a machine, a human running a
command from the prompt, an adapter delivering a message, a contact reading a
shared resource: each is one line with who, where, the call, the argument that
matters, the outcome, and the duration. It answers "what happened on my
installation" without depending on any process's history, which is compacted
into memory over time and was never meant to be an audit trail.

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
| `tokens`, `costNanoUsd` | When the response carries usage, as the ai calls do |

`detail` is redacted at write time and only ever holds: the first line of a
shell command, a path, a URL's host (never its path or query), a search query,
a model id, a process label, an adapter name, a config key. Bodies, message
text, prompt content, tokens, and credentials never enter the ledger, so a
segment is safe to hand to a client as it is.

## The window

Lines are written into `ledger_window` in the Kernel's own SQLite storage when
the call is dispatched, and completed with the outcome when the response is
known: inline for local calls, on the routed response for calls that went to a
machine, and on expiry or cancellation otherwise. The dispatch path only
inserts and counts; nothing else runs inline.

The window is bounded to 5,000 lines or 24 hours, whichever comes first. The
dispatch that crosses the row bound schedules the Kernel's alarm; the alarm
also runs daily.

## Segments

Rotation moves the oldest closed lines, up to 2,000 at a time, into one
immutable object under `ledger/<seq>.jsonl` in the installation's R2 storage,
one JSON line per ledger line. Lines still open after the window age are closed
as `cancelled` on the way out. Only after the object write succeeds does one
transaction delete those rows from the window and insert the segment's index
entry into `ledger_segments`: sequence range, first and last timestamp, row
count, bytes, and the set of process ids and targets present. A failed write
retries on the next alarm and prunes nothing. A segment stays well under 1.5 MB.

The index is what keeps reads cheap: a query filtered by process or place skips
every segment whose sets cannot contain a match.

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

`sys.ledger.list` returns lines newest first, paged by an opaque cursor: the
window first, then segments from newest to oldest. Filters are `pid`,
`target`, `callPrefix`, `since`, and `until`; `limit` is at most 200.
Visibility is the rule `proc.list` uses: a caller sees the lines of the human
who owns them, and root sees every line. The `ledger.appended` signal, sent to
the owner's connections and coalesced to a few per second, carries the newest
sequence and the count since the last signal, so a surface can tail the ledger
without polling.

## Cost

One insert and one count per dispatch in the transaction the Kernel already
holds, and one update on completion. Storage in the Kernel is the window plus
an index entry per segment, a few hundred bytes each. If the write ever shows
in Kernel latency, the same rows can move to a separate actor without changing
the wire.
