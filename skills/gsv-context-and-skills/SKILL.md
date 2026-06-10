---
name: gsv-context-and-skills
description: Guide on how context and skills work in GSV and how to add/edit them.
---

# GSV Context and Skills

## Prompt Assembly

GSV assembles process context from explicit, inspectable sources:

1. Profile context from `config/ai/profile/{profile}/context.d/*.md` or a user profile under `~/profiles.d/{profile}/context.d/*.md`.
2. Home context from `~/context.d/*.md`.
3. A compact top-level index of available skills from layered `skills.d` directories.
4. Process context supplied by the current assignment or runtime.

The skill index is for progressive disclosure. It shows only top-level skills, not full bodies, nested child skills, or long source paths. Use `skills list <skill>` or `skills tree <skill>` to disclose children under a parent, then `skills show <skill>` to read the relevant page.

Prompt context roots render as prompt-markup tags like `<system path="/sys/config/ai/context.d/">`, `<user path="/home/alice/context.d/">`, and `<program path="/home/agent/context.d/">`. The available skill catalog renders as `<available_skills>` containing top-level `<skill>` entries with `<name>` and `<description>`.

Tool and integration metadata is not the same thing as prompt context. The outer chat tool list may show only generic tools such as Shell, Read, and CodeMode, while connected MCP servers are mounted inside CodeMode as `mcpTools` metadata and generated async functions. Do not conclude that an MCP server is unavailable just because there is no top-level tool namespace for it.

## Skill Commands

Use the native shell:

```bash
skills tree
skills list
skills list <skill>
skills search <query>
skills show <skill>
skills files <skill>
skills read <skill> <file>
```

Read `skills show <skill>` before relying on a workflow. Use `skills files` and `skills read` for supporting references, templates, or examples.

A parent skill should describe the system area and point to narrower nested skills under its own `skills.d/`. Concrete child skills should describe one repeatable action. Do not turn one skill into a full encyclopedia of GSV.

## Where Information Belongs

- `config/ai/profile/{profile}/context.d/*.md`: short operator-managed role and runtime guidance.
- `~/profiles.d/{profile}/context.d/*.md`: user-authored worker profile specialization, available through spawn and schedules.
- `~/context.d/*.md`: concise user-global standing context useful to most processes.
- `~/skills.d/`: reusable user-level process workflows.
- `/src/packages/{package}/skills.d/`: workflows shipped by visible package source.
- Wiki repos: durable searchable reference material, not always-loaded prompt context.
- Explicit project files or repositories: task-local continuity, decisions, open loops, and handoff state.
- Process assignment context: current task instructions, temporary handoff notes, and files attached to a spawned process.

Repo-root `skills/` in `root/gsv` is only a distribution source. Bootstrap copies those files into user `~/skills.d/` when missing. Runtime processes read layered `skills.d`, not repo-root `skills/` directly.

## Editing Rules

1. Read the current file before editing.
2. Keep context files short and curated.
3. Put reusable procedures in skills, not profile or home context.
4. Put raw reference material in Wiki or a skill reference file, not always-loaded context.
5. Preserve user-authored structure and do not overwrite local skills just because a seeded source exists.
6. After a repeated correction or reusable workflow, update the relevant writable skill source.

Package skills follow package source rules. Edits under `/src/packages/<package>/skills.d` are staged until `pkg source commit`.
