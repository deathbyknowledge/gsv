---
name: gsv-context-and-skills
description: Guide on how context and skills work in GSV and how to add/edit them.
---

# GSV Context and Skills

## Prompt Assembly

GSV assembles process context from explicit, inspectable sources:

1. Profile context from `config/ai/profile/{profile}/context.d/*.md`.
2. Home context from `~/context.d/*.md`.
3. Workspace context from `/workspaces/{workspaceId}/.gsv/context.d/*.md`, when the process has a workspace.
4. A compact index of available skills from layered `skills.d` directories.
5. Process context supplied by the current assignment or runtime.

The skill index contains ids and descriptions only. It does not include full bodies or long source paths.

## Skill Commands

Use the native shell:

```bash
skills list
skills search <query>
skills show <skill>
skills files <skill>
skills read <skill> <file>
```

Read `skills show <skill>` before relying on a workflow. Use `skills files` and `skills read` for supporting references, templates, or examples.

## Where Information Belongs

- `config/ai/profile/{profile}/context.d/*.md`: short operator-managed role and runtime guidance.
- `~/context.d/*.md`: concise user-global standing context useful to most processes.
- `/workspaces/{id}/.gsv/context.d/*.md`: task-local continuity, decisions, open loops, and handoff state.
- `/workspaces/{id}/.gsv/summary.md`: fallback workspace summary when no workspace context files exist.
- `~/skills.d/`: reusable user-level process workflows.
- `/workspaces/{id}/.gsv/skills.d/`: project-specific workflows.
- `/src/packages/{package}/skills.d/`: workflows shipped by visible package source.
- `~/knowledge/`: durable searchable reference material, not always-loaded prompt context.
- Process assignment context: current task instructions, temporary handoff notes, and files attached to a spawned process.

Repo-root `skills/` in `root/gsv` is only a distribution source. Bootstrap copies those files into user `~/skills.d/` when missing. Runtime processes read layered `skills.d`, not repo-root `skills/` directly.

## Editing Rules

1. Read the current file before editing.
2. Keep context files short and curated.
3. Put reusable procedures in skills, not profile or home context.
4. Put raw reference material in knowledge or a skill reference file, not always-loaded context.
5. Preserve user-authored structure and do not overwrite local skills just because a seeded source exists.
6. After a repeated correction or reusable workflow, update the relevant writable skill source.

Package skills follow package source rules. Edits under `/src/packages/<package>/skills.d` are staged until `pkg source commit`.
