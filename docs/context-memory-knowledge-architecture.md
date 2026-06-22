# Context and Knowledge Architecture

GSV keeps context and durable knowledge as ordinary files in versioned
repositories. The kernel provides generic filesystem and repository primitives;
knowledge-specific behavior lives in the Wiki package app and CLI.

## Layers

| Layer | Location | Purpose |
|---|---|---|
| Home context | `~/context.d/` | Compact account context loaded into agent prompts. |
| Durable knowledge and memory | Wiki repos with `wiki.json` | Searchable markdown databases, agent memory pages, and source references. |
| Repository substrate | `repo.*` | Versioned reads, writes, diffs, imports, and history over ripgit repositories. |
| Filesystem substrate | `fs.*` | Linux-like file access across native GSV storage and routed devices. |

## Home Context

Home context is for information that should shape most agent sessions:

- persistent user preferences
- standing instructions
- durable identity or operating constraints
- small files that should always be prompt-visible

New human homes create an empty `~/context.d/` directory. New agent homes seed
`~/context.d/00-style.md`, `~/context.d/10-user.md`,
`~/context.d/15-memory.md`, and `~/context.d/20-open-loops.md` when those files
are missing. New personal agents also get a one-time
`~/context.d/00-boot.md` onboarding file that should be deleted after setup is
done.

Use `~/context.d/` for scoped snippets that should be prompt-visible every time.
Keep files short and specific. Large knowledge collections and long-term agent
memory belong in Wiki repos, not always-loaded context. Active open loops belong
in `~/context.d/20-open-loops.md`; closed-loop history and supporting evidence
belong in the `memory` wiki.

## Durable Knowledge

Durable knowledge is stored in normal ripgit repositories that contain a root
`wiki.json` manifest:

```text
wiki.json
index.md
pages/
```

Example manifest:

```json
{
  "kind": "gsv.wiki",
  "version": 1,
  "id": "memory",
  "title": "Agent Memory"
}
```

Each wiki is just markdown in a repository. `index.md` is the landing page.
`pages/` contains durable notes. Additional directories can exist when a
collection needs a domain-specific shape, but the default Wiki app and CLI
operate on `index.md` and `pages/`.

For agent memory, the conventional wiki id is `memory`; after creation it is
available through the filesystem at `/src/repos/<agent>/memory`.

## Wiki Semantics

The Wiki package app and `wiki` CLI command provide semantic operations over
wiki repos:

- list and initialize wiki collections
- read and write markdown pages
- search and query notes
- ingest live source references
- merge or annotate existing notes

These are product and CLI behaviors, not kernel syscalls. The implementation
uses generic repository operations against wiki repos, so other apps can build
their own knowledge workflows without depending on a special kernel domain.

## Source References

Knowledge pages may point back to live sources instead of copying content.

Example:

```markdown
## Sources
- [gsv] /home/alice/projects/acme/specs/auth.md | Auth spec
- [macbook] /Users/hank/Downloads/research.txt | Research notes
```

Source references are intentionally inspectable text. A page can cite GSV files,
home files, package source, explicit project files, or routed device paths without embedding the source corpus into
the home repo.

## Retrieval Model

Wiki repos are not loaded wholesale into prompts. Agents should use the Wiki
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
