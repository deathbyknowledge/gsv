---
name: memory
description: Retrieve and maintain the memory. Use when you need to remember something. personal history, preferences, people, projects, decisions, routines, places, or prior events or when the user asks to remember something.
---

# Manage Personal Memory

Memory belongs to the human, not to an individual agent. It has three layers; every agent working for the same user shares the first two, and only Ship reads the third:

- The owner's `context.d/10-personal.md` contains a very small set of stable facts and preferences that should affect nearly every interaction. It appears under the editable `<user>` context root in the prompt; do not confuse it with the current agent's `~/context.d/`.
- The `personal` wiki contains durable information that is searched and loaded when relevant.
- The conversation keeps every message exchanged with the owner and Ship. Ship can search it; it is the record, not the memory, so write what will matter again to the wiki.

The Kernel responsibility ledger is working state, not personal memory. Do not copy unresolved responsibilities into the wiki merely because they exist. Record an outcome later only when it is useful history.

## Decide When to Read

Retrieve memory before asking, recommending, or acting when the correct interpretation or outcome could depend on personal history that is not already in the current context. Examples include an ambiguous person or project name, the user's usual grocery order, travel details, prior decisions, recurring preferences, and where the user normally keeps something.

Do not search memory for self-contained questions whose answer cannot depend on the user. Do not search merely to prove that memory exists.

Search narrowly before opening broad pages:

```bash
wiki search <query> --prefix personal
```

Use `wiki info personal` when the page location is unknown. Once a relevant page is known, use normal filesystem tools to read its Markdown under the path reported by `wiki info`.

## Decide When to Write

Write immediately when the user explicitly says to remember an unambiguous fact or corrects an existing fact. Also write a concrete, stable fact or preference that the user states explicitly when it will improve future help.

When work reveals durable context about a person or relationship, preserve it promptly even if the user did not explicitly ask you to remember it. This includes identity, alternate names or handles, how the person relates to the user, ongoing shared projects, and meaningful interaction outcomes. Do not wait for compaction or a later request to make the information durable. Record inferred context as an inference rather than omitting it, and include a date or source when it will help resolve future ambiguity.

Search and merge before writing when the fact may already exist, refers to an ambiguous person or project, supersedes older information, or belongs on more than one existing page. Ship can perform short lookups and edits directly; delegate when the work benefits from parallel execution, separate context, or lengthy investigation.

Append a journal entry for a meaningful event or outcome whose chronology may matter later. Use ISO dates:

```bash
pages/journal/YYYY/MM/YYYY-MM-DD.md
```

## Find Something Said Earlier

When the owner refers to something from an earlier exchange that the wiki does not hold, Ship searches the conversation before asking them to repeat it. Helpers can't read the conversation; they ask Ship.

```bash
message search "words" --json
message history --before SEQUENCE --limit 10
```

Search matches messages containing every word, newest first; short words match the start of longer ones. Each hit carries its `sequence`; page older matches by passing the returned `nextBeforeSequence` to `--before`. `message history --before` reads the messages before a sequence, so pass one a few past the hit to see what followed it as well. `--with` searches a contact's conversation instead. Messages from before search existed are not indexed, so when a search finds nothing, page back with `message history` before concluding it was never said. When the answer will matter again, write it to the wiki.

## Recover Missing Memory from Process History

Process history is lossless recovery evidence, not the primary memory system. Search the Personal wiki and the conversation first. If relevant memory is still missing and earlier Process work likely contains the answer, such as a tool result that never reached a message, inspect that history and then repair the wiki with the durable facts you recover.

For compacted history belonging to a visible Process, prefer the structured Process interface:

```bash
proc segments --pid <pid>
proc segment <segment-id> --pid <pid> --json
```

Reset and terminated Process transcripts are stored as gzipped JSONL under the run-as agent's home. Locate candidate archives and stream them through `zcat`; do not try to read compressed bytes as text or modify the immutable archive:

```bash
find "$HOME/processes" -name '*.jsonl.gz'
zcat "$HOME/processes/<pid>/history/<archive>.jsonl.gz" \
  | jq -r '[.ts, .role, .content] | @tsv' \
  | rg -i '<term>'
```

Search narrowly by likely Process or date when possible. Once the missing context is recovered, merge the useful facts into the appropriate Personal wiki page. Do not copy raw transcripts, reasoning, or tool noise into memory.

## Organize the Wiki

Search before adding duplicate information. Read a page before editing it. Keep `index.md` as an orientation page and use `inbox/` only for information that genuinely cannot yet be placed. Promote durable information into topical pages such as:

- `pages/people/`
- `pages/projects/`
- `pages/preferences/`
- `pages/decisions/`
- `pages/routines/`
- `pages/places/`
- `pages/concepts/`

When a name is ambiguous, make the short-name page a disambiguation page that points to specific pages. Replace superseded facts rather than accumulating contradictions. Prefer concise facts and useful context over prose about the act of remembering.

Use `man wiki` for exact wiki syntax and general wiki workflows.

## Maintain Standing Memory

Edit the owner's `context.d/10-personal.md` only for explicit, stable facts or preferences that should be present in almost every interaction. Keep the file small, preserve its purpose statement, and replace corrected facts.

Unresolved work belongs in the `r12y` responsibility ledger. Do not duplicate it in standing context or the wiki.
