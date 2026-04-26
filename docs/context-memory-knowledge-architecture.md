# Context and Knowledge Architecture

GSV keeps context and durable knowledge as ordinary files in versioned
repositories. The kernel provides generic filesystem and repository primitives;
knowledge-specific behavior lives in the Wiki package app and CLI.

## Layers

| Layer | Location | Purpose |
|---|---|---|
| Home context | `~/CONSTITUTION.md`, `~/context.d/` | Always-relevant user and system context loaded into agent prompts. |
| Workspace context | `/workspaces/{id}/.gsv/context.d/`, `/workspaces/{id}/.gsv/summary.md` | Project-local continuity, task state, and handoff notes. |
| Durable knowledge | `~/knowledge/` | User-controlled markdown databases, pages, inbox notes, and source references. |
| Repository substrate | `repo.*` | Versioned reads, writes, diffs, imports, and history over ripgit repositories. |
| Filesystem substrate | `fs.*` | Linux-like file access across native GSV storage and routed devices. |

## Home Context

Home context is for information that should shape most agent sessions:

- persistent user preferences
- standing instructions
- durable identity or operating constraints
- small files that should always be prompt-visible

Use `~/context.d/` for scoped snippets. Keep files short and specific. Large
knowledge collections belong in `~/knowledge/`, not always-loaded context.

## Workspace Context

Workspace context is task-local. It records what matters for the current
workspace without polluting user-global memory.

Typical files:

```text
/workspaces/{workspaceId}/.gsv/context.d/*.md
/workspaces/{workspaceId}/.gsv/summary.md
```

Use workspace context for active decisions, current project assumptions,
handoff state, and compacted task continuity.

## Durable Knowledge

Durable knowledge is stored under:

```text
~/knowledge/
```

The conventional layout is:

```text
~/knowledge/
  personal/
    index.md
    pages/
    inbox/
  product/
    index.md
    pages/
    inbox/
```

Each database is just markdown in the user's home repo. `index.md` is the
database landing page. `pages/` contains canonical notes. `inbox/` contains
staged notes that should be reviewed before becoming canonical.

## Wiki Semantics

The Wiki package app and `wiki` CLI command provide semantic operations over
`~/knowledge/`:

- list and initialize databases
- read and write markdown pages
- search and query notes
- ingest live source references
- compile inbox notes into canonical pages
- merge or annotate existing notes

These are product and CLI behaviors, not kernel syscalls. The implementation
uses generic repository operations against the home repo, so other apps can build
their own knowledge workflows without depending on a special kernel domain.

## Source References

Knowledge pages may point back to live sources instead of copying content.

Example:

```markdown
## Sources
- [gsv] /workspaces/acme/specs/auth.md | Auth spec
- [macbook] /Users/hank/Downloads/research.txt | Research notes
```

Source references are intentionally inspectable text. A page can cite GSV files,
workspace files, or routed device paths without embedding the source corpus into
the home repo.

## Retrieval Model

`~/knowledge/` is not loaded wholesale into prompts. Agents should use the Wiki
surface, shell tools, `fs.*`, or `repo.*` to inspect it deliberately.

This keeps the prompt small and makes retrieval visible:

- always-loaded context stays compact
- durable knowledge remains human-editable
- reads and writes are auditable through normal repository history
- agents use Linux-like file and CLI patterns instead of hidden memory channels

## Design Rule

Do not add a kernel syscall for a knowledge workflow unless it is truly generic
infrastructure. Most knowledge behavior belongs in an app, package backend, CLI,
or agent workflow layered on top of `repo.*` and `fs.*`.
