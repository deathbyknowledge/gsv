# Context and Knowledge Architecture

GSV keeps standing context and durable knowledge as ordinary files in versioned
repositories. Memory belongs to the human rather than to one agent. The kernel
provides generic filesystem and repository primitives; knowledge-specific
behavior lives in agent workflows and the Wiki shell surface.

Memory's Markdown reader shares the conversation's code blocks: long lines scroll within the
block, and copy preserves the code's indentation and internal line breaks.
Memory's scrolling panes show a lavender top edge only where it cuts through
text; blank space between lines and sections leaves the edge clear.

On phones, Memory shows either the full-height page browser or the reader/editor.
**← pages** returns to the browser with its position and any editor draft intact;
**continue editing →** returns to that draft. Wider screens keep both panes visible.
The page browser and reader each center a large spinner while their data loads,
with a loading label for screen readers and no visible caption.
Touch scrolling does not highlight pages or folders; tapping opens them. Mouse hover and
keyboard focus retain their navigation feedback.

Memory’s **ask Ship** control adds the page’s GSV repository path to the
Chat composer as ordinary editable text, preserving the existing draft and
attachments. It does not send or edit the page. The eventual message uses the
normal conversation text contract, without request-specific metadata.

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

Newly archived Ship history also produces a bounded memory-review responsibility.
Only one review is admitted per owner at a time. Its brief asks Ship to delegate
the new slice, merge it with current memory using revision-checked writes, and
resolve the responsibility only after successful review. This supplements saving
useful facts during ordinary work; compaction never waits for it. The
`memory.review` responsibility source controls new admissions. See
[Context Compaction](./context-compaction.md) for delivery and checkpoint ownership.

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

Repository authors edit shipped standing defaults under
`workers/gateway/src/prompts/{system,ship,crew,user}/context.d/*.md`. Each file is
one complete entry; its scope and lexical ordering are visible in its path.
TypeScript bundles those complete files through the shared `context.ts`
catalogue. Standalone tasks and onboarding responsibility briefs remain separate.

Shared system entries explain GSV-specific decisions: choosing targets,
interpreting message origins and runtime events, sending human-facing output
through Send, returning delegated results, and preserving knowledge. Memory
instructions appear once in system context; personal facts remain in the
owner's standing context and detailed knowledge in the personal wiki.

Ship prioritizes acknowledgment and continued responsiveness, then appropriate
responsibility bookkeeping, then execution or delegation. Crew's role defines
the assigned outcome and evidence to report. Ship's voice stays separate from
delivery mechanics. Command recipes remain in discoverable skills and manuals.

`npm run review:prompts` opens a local editor with individual entry previews,
source links, and exact Ship/Crew standing prompts. It uses the production
assembler, the same catalogue and sample runtime facts. Saving changes repository
defaults, without contacting a live space.

System defaults remain live except where explicitly overridden. Account defaults
seed missing files. Home scaffolding also replaces recognized generated Ship
roles and retires generated account-local memory entries when adopting the
shared system memory entry. The Kernel also checks the run-as and owner accounts
before a Process requests context, covering existing specialist processes. A
successful check is reused for that Kernel lifetime. Customized and concurrent
edits are preserved. An explicit override
of the formerly combined `01-gsv.md` remains authoritative: migration leaves the
new `02-interaction.md` empty unless it already has an explicit override.

See `tools/source-review/README.md` for the authoring workflow.

## See also

- [Context Compaction](./context-compaction.md)
- [The Agent Loop](./agent-loop.md)
- [Context Files Reference](../reference/context-files.md)
