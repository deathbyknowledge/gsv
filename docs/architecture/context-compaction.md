# Context Compaction

GSV compacts process history when its assembled model context approaches
the selected model's input budget. It replaces enough of the oldest completed
history with a summary to restore a configured amount of runway, and archives
the exact removed records. It does not write facts into the user's context or
knowledge files.

## Ownership

The Process Durable Object owns compaction because it owns process history,
the active run, and cancellation. `ProcessStore` owns its SQLite messages,
policies, and segment records. The implementation lives in
`gateway/src/process/do.ts`, `store.ts`, and `context-pressure.ts`; the public
boundary is the `proc.history.*` syscall family.

## Context pressure

Before a model call, the process measures the same assembled system prompt,
messages, and tools it will send to inference. It reuses provider-confirmed usage
for the latest matching assistant prefix, then estimates only content added after
that response. If no matching prefix exists, it estimates the whole request.
The estimate uses serialized character length with a safety factor; images use a
fixed conservative token cost instead of counting encoded bytes.
The usable input budget is:

```text
context window - configured maximum output tokens
```

Pressure is measured input tokens divided by that budget. The state exposes the
confirmed prefix, estimated trailing input, absolute input budget, and absolute
remaining input. It is persisted for the process, returned by `proc.history`, and
emitted through `proc.changed` with a monotonic revision so delayed history loads
cannot replace newer state. The revision survives compaction and reset even though
those operations discard the obsolete pressure snapshot.

Provider usage confirms only the exact request it measured. Once a response or
tool result has been appended, the Process builds a new snapshot from the
confirmed prefix plus estimated trailing content rather than applying the old
request total to the newer context. Reuse also requires the same provider, model,
context epoch, and opaque generation-context identity derived from the effective
system prompt and offered tools. A matching model response from another epoch or
from an IPC/interactive context variant cannot confirm the live prompt prefix.

An unknown model context window produces unknown pressure, not an invented
limit. If the provider reports that the assembled request exceeds its context
window, the Process applies the same history policy regardless of the estimate.
Context overflow does not advance the main generation fallback chain.

## Context runway event

Before the hard overflow-policy boundary, the Process emits one
`[GSV EVENT]` per context epoch so the agent can preserve durable knowledge,
standing facts, or unresolved commitments deliberately. The event reports
absolute remaining input tokens and is included in the current model call. It
does not itself write memory, create a responsibility, or compact history.

The alert threshold targets up to 64,000 tokens before the configured boundary,
capped at 20% of the model's usable input budget. With the default `0.9` compaction
boundary, smaller windows therefore alert around `0.7` pressure; larger windows
alert later while retaining the same bounded token runway. A persisted context
epoch marker prevents corrected estimates, repeated tool turns, or Durable
Object eviction from repeating the alert. Compaction closes the epoch and
re-arms the alert for the replacement context. Preflight evaluates the soft
overflow boundary before appending the event, so the event itself cannot be
compacted or fail the run before the model sees it.

## Overflow policy

Each process has an `auto-compact` or `fail` policy, a high-water pressure
threshold, and a low-water target. The default triggers at `0.9` pressure and
compacts to `0.4`. Both values are fractions of the model's usable input budget,
not fractions or counts of stored messages. The policy is exposed through
`proc.history.policy.get` and `proc.history.policy.set`.

- `auto-compact` estimates the oldest prefix required to reach the low-water
  target, reserves room for its replacement summary, and compacts that prefix
  during preflight or after the first provider-confirmed overflow. It rebuilds
  the context and retries the same active model configuration once.
- `fail` ends the run with a visible system error during preflight or after a
  provider-confirmed overflow, and leaves the process available for explicit
  compaction or reset.

One generation cycle installs at most one automatic compaction. A later tool
round may compact again if newly stored results grow the next assembled context.
The active run's input is never selected. Selection advances across an assistant
tool call and all of its results as one unit. If the rebuilt request remains above
the low-water target, or no completed older prefix can be archived, the current
run stops explicitly rather than looping, recompacting only the prior summary,
or switching models.

Explicit compaction remains available as an operation; `manual` is not an
overflow policy.

## Compaction operation

`proc.history.compact` requires exactly one prefix selector:

- `keepLast` retains a recent tail.
- `throughMessageId` selects a prefix through a stored message id.

The caller must also provide a summary or set `generateSummary: true`. Explicit
compaction rejects an active process. Automatic compaction runs inside the
owning run's lifecycle, from preflight or provider-overflow recovery, and stops
if that run is superseded or aborted.

A successful compaction:

1. selects an old prefix without separating an assistant tool call from its tool
   results;
2. archives those records as gzipped JSONL in R2;
3. replaces the live prefix with a system summary and archive path; and
4. records a `compaction` segment with the archived message range.

The process then rebuilds context before calling the model. Summary or archive
failure stops the run explicitly; GSV does not install a content-free summary.
Successful installation clears the old pressure estimate because it no longer
describes the live history. Generated summaries use the selected AI
configuration's normal generation deadline rather than a separate shorter
compaction timeout.

## Archives and restoration

The summary is lossy, but the archived records are not:

- `proc.history.segments` lists compacted segments.
- `proc.history.segment.read` pages through an archived segment.
- `proc.fork` can initialize a new process from a live prefix or compacted
  segment.

Reset and process teardown use the same archive substrate for the live working
window, but are separate lifecycle operations. Reset does not extract memories
or schedule daily or idle resets.

## See also

- [Context and Knowledge](./context-and-knowledge.md)
- [The Agent Loop](./agent-loop.md)
- [Syscalls Reference](../reference/syscalls.md)
- [Context Files Reference](../reference/context-files.md)
