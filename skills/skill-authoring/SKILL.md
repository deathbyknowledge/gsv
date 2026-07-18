---
name: skill-authoring
description: Create or revise reusable GSV agent workflows under skills.d. Use when the user asks to automate, save, teach, repeat, or reuse a workflow, or accepts an offer to preserve a proven workflow for later.
---

# Author GSV Skills

Persist a workflow only after it succeeds and its reusable steps are understood.
Do not silently save one-off work or sensitive material. Never include credentials,
tokens, private content, transient message or target identifiers, or user-specific
data that is not essential to the procedure.

## Create a Skill

1. Search before creating: `skills search <goal>` and inspect matches with
   `skills show <skill>`.
2. Choose a short lowercase hyphenated name. Make the description state both
   what the workflow does and when it should trigger.
3. Draft only the Markdown instruction body in a temporary file. Keep verified,
   non-obvious steps, exact GSV commands, decision points, validation, and common
   failure recovery. Omit conversation history and explanatory padding.
4. Persist and verify it:

```bash
skills create <name> --description '<what it does and when to use it>' --from <body-file>
skills validate <name>
skills show <name>
```

Add scripts, references, or assets under `~/skills.d/<name>/` only when they make
the repeated workflow more reliable. Reference each supporting file directly
from `SKILL.md`.

## Revise a Skill

Read the current skill and its supporting files first:

```bash
skills show <name>
skills files <name>
```

Use `--replace` only when the user requested an update or explicitly accepted a
correction. It replaces `SKILL.md`, not the supporting files:

```bash
skills create <name> --description '<revised trigger description>' --from <revised-body-file> --replace
skills validate <name>
skills show <name>
```

Do not leave placeholders. If the workflow is not yet proven or contains details
that should not become durable procedural memory, finish the task without
persisting it and offer skill creation separately.
