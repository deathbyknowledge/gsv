# Context and Knowledge Architecture

GSV keeps standing context and durable knowledge as ordinary files in versioned
repositories. Memory belongs to the human rather than to one agent. The kernel
provides generic filesystem and repository primitives; knowledge-specific
behavior lives in agent workflows and the Wiki shell surface.

## Layers

| Layer | Location | Purpose |
|---|---|---|
| Program context | `<agent home>/context.d/` | Role, voice, and standing state private to one agent account. |
| User context | `<human home>/context.d/` | Compact standing context layered into every agent owned by that human. |
| Personal wiki | `/src/repos/<human>/personal/` | Human-owned durable, searchable personal memory shared by all owned agents. |
| Other wikis | `/src/repos/<owner>/<wiki>/` | User-controlled markdown collections and source references. |
| Repository substrate | `repo.*` | Versioned reads, writes, diffs, imports, and history over ripgit repositories. |
| Filesystem substrate | `fs.*` | Linux-like file access across native GSV storage and routed devices. |

## Standing context

The human owner's context is for information that should shape nearly every
interaction:

- persistent preferences
- explicit stable personal facts
- standing instructions
- durable identity or operating constraints

The conventional shared file is `context.d/10-personal.md`. An owned agent sees
it under the editable `<user>` prompt root; `~` still refers to that agent's own
home. Keep shared context short and specific. Role instructions, voice, and the
personal intelligence's stable program context stay in the personal agent
account. Unresolved work belongs in the Kernel responsibility ledger rather
than standing context. Detailed or occasionally relevant information belongs
in the Personal wiki.

## Personal wiki

Each human receives a `personal` wiki. It is a normal registered ripgit repo:

```text
/src/repos/<human>/personal/
  wiki.json
  index.md
  inbox/
  pages/
    journal/YYYY/MM/YYYY-MM-DD.md
    people/
    projects/
    preferences/
    decisions/
    routines/
    places/
    concepts/
```

`index.md` is the orientation page. `pages/` contains canonical notes and dated
journal entries. `inbox/` is only for information that cannot yet be placed.
Additional wikis use the same manifest and repository convention.

## Wiki semantics

The `wiki` shell command provides semantic operations over registered wiki
repositories:

- list and initialize collections
- inspect page trees
- read and search markdown pages
- ingest or attach live source references

These are shell behaviors, not special memory syscalls. Page changes use normal
filesystem and repository operations, so permissions, diffs, and history stay
inspectable.

## Source references

Knowledge pages may point back to live sources instead of copying content.

Example:

```markdown
## Sources
- [gsv] /workspaces/acme/specs/auth.md | Auth spec
- [macbook] /Users/hank/Downloads/research.txt | Research notes
```

Source references are intentionally inspectable text. A page can cite GSV files,
workspace files, or routed device paths without embedding the source corpus into
the wiki.

## Retrieval and writing

Wiki contents are not loaded wholesale into prompts. Agents retrieve from the
Personal wiki before asking, recommending, or acting when personal history not
already in context could change the outcome. Self-contained questions do not
need a memory search.

Explicit, unambiguous requests to remember something can be written directly.
Potential duplicates, corrections, ambiguous people or projects, and inferred
outcomes require a search and merge. Ship can perform short lookups and edits
directly, delegating when duration, parallelism, or context needs justify a worker.
Ship and Crew use the same human-owned `personal` collection while keeping their
instructions in separate account homes.

This keeps the prompt small and the behavior inspectable:

- always-loaded context stays compact
- durable knowledge remains human-owned and human-editable
- reads and writes are auditable through normal repository history
- agents use Linux-like file and CLI patterns instead of hidden memory channels

## Design rule

Do not add a kernel syscall for a knowledge workflow unless it is truly generic
infrastructure. Most knowledge behavior belongs in the shell or an agent
workflow layered on top of `repo.*` and `fs.*`. The runtime guarantees that the
Personal wiki exists and that authorized owned agents can reach it; the
intelligence decides when information is worth retrieving or preserving.

## Authoring defaults

Repository authors edit shipped standing defaults and standalone task prompts as
Markdown under `workers/gateway/src/prompts/`. The sources are grouped by world
model, interaction, computer/discovery, durable work, knowledge, role/judgment,
voice, and instance facts. Scope stays explicit within each category: shared,
Ship, Crew, generic agent, or owner. Separate task prompts cover compaction,
onboarding, delegated-run delivery, and corrections.

The shared defaults explain the relationship between the human owner, agent
account, process, run, conversation, and target. Input guidance distinguishes
human messages, process requests, schedules, and runtime events; delivery guidance
distinguishes explicit human-facing messages from delegated return values.
Continuity guidance explains how an epoch's initial runtime facts and
responsibilities are updated by later events across runs.

Each category owns its rules. Ship's role focuses on immediate acknowledgment,
execution choices, and follow-through; Crew's role focuses on the assigned outcome
and its evidence. Both use the same knowledge source. Voice stays separate from
delivery mechanics, and instance templates contain values rather than policy.
Command recipes remain in the discoverable skills and manuals.

TypeScript composes these sources into the existing system and account context
files, preserving their stored paths and assembly order. `npm run review:prompts`
opens a local editor with category previews, links from assembled sections to
their contributing sources, and exact Ship/Crew standing prompts. The previews use the
production assembler and sample runtime facts. Saving edits changes repository
defaults; existing account context files and explicit system overrides remain
under their owners' control.
See `tools/source-review/README.md` for the authoring workflow.

## See also

- [Context Compaction](./context-compaction.md)
- [The Agent Loop](./agent-loop.md)
- [Context Files Reference](../reference/context-files.md)
