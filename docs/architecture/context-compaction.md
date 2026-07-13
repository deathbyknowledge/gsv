# Context Compaction

GSV compacts a process conversation when its assembled model context approaches
the selected model's input budget. It keeps a recent tail live, replaces an older
prefix with a summary, and archives the exact removed records. It does not write
facts into the user's context or knowledge files.

## Ownership

The Process Durable Object owns compaction because it owns conversation history,
the active run, and cancellation. `ProcessStore` owns its SQLite messages,
policies, and segment records. The implementation lives in
`gateway/src/process/do.ts`, `store.ts`, and `context-pressure.ts`; the public
boundary is the `proc.conversation.*` syscall family.

## Context pressure

Before a model call, the process estimates tokens from the same assembled system
prompt, messages, and tools it will send to inference. The estimate uses
serialized character length with a safety factor and replaces embedded image data
with a small placeholder. The usable input budget is:

```text
context window - configured maximum output tokens
```

Pressure is estimated input tokens divided by that budget. Its state is persisted
per conversation, returned by `proc.history`, and emitted through `proc.changed`.
Provider usage updates the state after a response; preflight always recomputes
the estimate for the next request.

An unknown model context window produces unknown pressure, not an invented
limit. The provider may still reject the request; normal generation fallback and
error handling then apply.

## Overflow policy

Each conversation has an independent `auto-compact` or `fail` policy, a pressure
threshold, and a `keepLast` value. The default auto-compacts at `0.9` pressure
while retaining the newest 80 stored messages. The policy is exposed through
`proc.conversation.policy.get` and `proc.conversation.policy.set`.

- `auto-compact` generates a summary and compacts the old prefix before the
  model call.
- `fail` ends the run with a visible system error and leaves the conversation
  available for explicit compaction or reset.

Explicit compaction remains available as an operation; `manual` is not an
overflow policy.

## Compaction operation

`proc.conversation.compact` requires exactly one prefix selector:

- `keepLast` retains a recent tail.
- `throughMessageId` selects a prefix through a stored message id.

The caller must also provide a summary or set `generateSummary: true`. Explicit
compaction rejects an active conversation. Automatic compaction runs in the
owning run's preflight and stops if that run is superseded or aborted.

A successful compaction:

1. selects an old prefix without separating an assistant tool call from its tool
   results;
2. archives those records as gzipped JSONL in R2;
3. replaces the live prefix with a system summary and archive path; and
4. records a `compaction` segment with the archived message range.

The process then rebuilds context before calling the model. Summary or archive
failure stops the run explicitly; GSV does not install a content-free summary.

## Archives and restoration

The summary is lossy, but the archived records are not:

- `proc.conversation.segments` lists compacted segments.
- `proc.conversation.segment.read` pages through an archived segment.
- `proc.conversation.fork` can restore a segment into another conversation.

Reset and process teardown use the same archive substrate for the live working
window, but are separate lifecycle operations. Reset does not extract memories
or schedule daily or idle resets.

## Durable context

Durable information belongs in inspectable `~/context.d/`, workspace
`.gsv/context.d/`, or `~/knowledge/` files. Compaction summaries remain
conversation records. Agents or users may write conclusions to those files with
normal filesystem operations; the runtime does not do so automatically.

## See also

- [Context and Knowledge](./context-and-knowledge.md)
- [The Agent Loop](./agent-loop.md)
- [Syscalls Reference](../reference/syscalls.md)
- [Context Files Reference](../reference/context-files.md)
