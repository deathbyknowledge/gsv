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

## Built-in Manual updates

`root/gsv-manual` is a local, searchable copy of the Manual. The Gateway pins its
compatible upstream commit in `workers/gateway/src/kernel/sys/manual-version.json`.
Maintainers advance this pin alongside changes documented in the Manual; a Manual
repository merge alone does not change an already deployed Gateway's dependency.

Setup imports that revision. On subsequent authenticated activity, the Kernel
checks a durable update record and refreshes an existing installation when the
configured source or bundled revision changes. Requests keep using the installed
copy during the refresh. Successful checks survive eviction; there is no polling
alarm or fetch on every request. Failed or interrupted updates retry on activity
after five minutes. Installation lifecycle admission also gates these updates.
Deleting the Manual cancels an in-flight refresh: its late result cannot restore
repository contents or registration. Automatic updates leave a deleted Manual
absent; an explicit refresh can install it again.

The importer preserves local edits, including edits made during a fetch. An
untouched imported copy can follow a version upgrade or rollback. A divergent
copy remains in place; `wiki info gsv-manual` shows the last synchronization
outcome and observed local revision. `wiki refresh gsv-manual` explicitly retries
without changing account skills. It retains its existing `sys.bootstrap`
capability requirement.

Operators can retain a custom upstream/ref through
`GSV_MANUAL_BOOTSTRAP_UPSTREAM` and `GSV_MANUAL_BOOTSTRAP_REF`. Mutable custom refs
are checked on a bundled-revision/configuration change or explicit refresh, not
continuously. A custom upstream without a ref continues to use `main`.

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
voice, instance facts, and onboarding. Scope stays explicit within each category: shared,
Ship, Crew, or owner. Separate task prompts cover compaction,
onboarding, delegated-run delivery, and corrections.

The shared defaults orient the agent within a persistent, Linux-like computer,
building on familiar Unix concepts. They explain GSV-specific decisions: choosing
targets, interpreting message origins and runtime events, sending human-facing
output through Send, and returning delegated results. Later events supersede
initial facts; files and responsibilities preserve continuity.

Each category owns its rules. Ship prioritizes acknowledgment and continued
responsiveness, then appropriate responsibility bookkeeping, then execution or
delegation. Crew's role defines the assigned outcome and evidence to report; no
generic voice is seeded. Both use the same knowledge source. Ship's voice stays
separate from delivery mechanics, and instance templates contain values rather
than policy. Command recipes remain in the discoverable skills and manuals.

TypeScript composes these sources into the existing system and account context
files, preserving their stored paths and layer order. `npm run review:prompts`
opens a local editor with category previews, links from assembled sections to
their contributing sources, and exact Ship/Crew standing prompts. The previews use the
production assembler and sample runtime facts. Saving edits changes repository
defaults; existing account context files and explicit system overrides remain
under their owners' control.
Home scaffolding removes retired generic style files only when their contents
exactly match a generated default; customized and concurrent edits are preserved.
See `tools/source-review/README.md` for the authoring workflow.

## See also

- [Context Compaction](./context-compaction.md)
- [The Agent Loop](./agent-loop.md)
- [Context Files Reference](../reference/context-files.md)
