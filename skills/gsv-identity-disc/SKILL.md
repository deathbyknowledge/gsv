---
name: gsv-identity-disc
description: Use and maintain GSV Identity Disc `.idz` memory files for compact durable process memory.
---

# GSV Identity Disc

## Purpose

Use an Identity Disc when future processes need a compact, searchable memory
index without loading raw transcripts or a large knowledge base.

Conventional paths:

```text
~/identity.idz
/workspaces/{workspaceId}/.gsv/identity.idz
```

The prompt includes only summaries and entry indexes from these files. Read the
full `.idz` file before relying on omitted details.

## When To Write

Add or update an entry when you learn something durable:

- a user preference or standing fact
- a decision that affects future work
- a reusable procedure that is too small for a full skill
- an open loop or handoff item
- a source reference future processes should inspect
- a package/runtime constraint that explains later behavior

Do not use `.idz` for raw logs, copied source files, large notes, or complete
chat transcripts.

## Format

Use the line-oriented format:

```idz
# idz/v1
@summary "Short prompt-visible memory summary."

@entry id="stable-id" kind="decision" scope="workspace" summary="Compact prompt-visible summary." tags="runtime,memory" confidence="high" updated="2026-05-25T10:00:00.000Z"
Optional body detail that stays out of the prompt until the file is read.
```

Good `kind` values: `fact`, `preference`, `decision`, `procedure`, `source`,
`todo`, `event`, `note`.

Good `scope` values: `home`, `workspace`, `package`, `process`, `target`,
`system`.

## Editing Workflow

1. Read the existing disc first.
2. Preserve existing entries and unknown attributes.
3. Use stable ids so entries can be updated instead of duplicated.
4. Keep `summary` short enough to fit in prompt indexes.
5. Put bulky detail in the body or an external source file and link with `source`.
6. Prefer workspace `.gsv/identity.idz` for task-local memory and `~/identity.idz` for user-global memory.

Package code can use `@gsv/package/identity-disc` for parsing, updating,
serializing, searching, and rendering `.idz` files.
