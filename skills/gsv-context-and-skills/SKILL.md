---
name: gsv-context-and-skills
description: Decide what GSV context or reusable workflow to load or edit, including profile/home/workspace/process context, skills.d layers, and skills list/search/show/files/read.
---

# GSV Context and Skills

## When to Use

Use this skill when deciding whether information belongs in prompt context, durable knowledge, workspace state, or a reusable skill.

## Prompt Context Order

GSV assembles process context in this order:

1. Profile context from `config/ai/profile/{profile}/context.d/*.md`.
2. Home context from `~/context.d/*.md`.
3. Workspace context from `/workspaces/{workspaceId}/.gsv/context.d/*.md`.
4. Available skills from layered `skills.d` directories as a compact index only.
5. Process context supplied by the current assignment or runtime.

The skill index contains ids and descriptions. It does not include full bodies or long source paths.

## Skill Commands

Use the native shell command surface:

```bash
skills list
skills search <query>
skills show <skill>
skills files <skill>
skills read <skill> <file>
```

Read `skills show <skill>` before following a workflow that might matter. Use `skills files` and `skills read` for supporting references and templates.

## Where Things Belong

- `~/context.d/*.md`: short standing user context that should be present for most processes.
- `/workspaces/{id}/.gsv/context.d/*.md`: task-local continuity, decisions, open loops, and handoff state.
- `/workspaces/{id}/.gsv/summary.md`: fallback workspace summary when no workspace context files exist.
- `~/skills.d/`: reusable user-level process workflows.
- `/workspaces/{id}/.gsv/skills.d/`: project-specific workflows.
- `/src/packages/{package}/skills.d/`: workflows shipped by a visible enabled package.
- `~/knowledge/`: durable searchable reference material, not always-loaded prompt context.

Repo-root `skills/` in the `root/gsv` source tree is a distribution source. During bootstrap, GSV copies those files into user `~/skills.d/` when missing. Runtime processes read `skills.d`, not the repo-root `skills/` path directly.

## Editing Rules

1. Read the current file before editing.
2. Keep context files short and curated.
3. Put reusable procedures in skills, not in general context.
4. After a difficult reusable workflow or a correction, update the relevant writable skill source.
5. Preserve user-authored structure and do not overwrite local skills just because a seeded source exists.

Package skills follow package source rules: edits under `/src/packages/<package>/skills.d` are staged until `pkg source commit`.
