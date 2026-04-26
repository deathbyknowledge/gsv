# Context Files Reference

GSV assembles process prompts from explicit context providers, not from hidden agent state. The important rule for agents is Linux-like: context is represented as inspectable Markdown files at stable paths, and edits use normal filesystem tools.

## Prompt Context Sources

Prompt context is collected in provider order:

1. **Profile context** from `config/ai/profile/{profile}/context.d/*.md`.
2. **Home context** from `~/context.d/*.md`.
3. **Workspace context** from `/workspaces/{workspaceId}/.gsv/context.d/*.md`, when the process has a workspace.
4. **Process context** supplied by the current assignment or runtime.

Profile files are operator-managed instructions for roles such as `task`, `review`, `cron`, `mcp`, `app`, `archivist`, and `curator`. They may use template keys such as `identity.home`, `workspace`, `devices`, and `known_paths`.

Home and workspace context files are loaded lexically, include only non-empty `.md` files, and are bounded by `config/ai/max_context_bytes`.

## Home Context: `~/context.d/`

Use `~/context.d/*.md` for small, curated user-global notes that should be available to most processes. This is for standing context, not raw logs or a private database.

Good examples:

```text
~/context.d/00-identity.md
~/context.d/10-communication.md
~/context.d/20-current-priorities.md
```

Keep these files short and stable. Put durable reference material under `~/knowledge/` instead, where it can be searched and retrieved deliberately.

## Workspace Context: `.gsv/context.d/`

Workspace context is task-local continuity. It is loaded only when the process has a `workspaceId`.

Recommended layout:

```text
/workspaces/{workspaceId}/.gsv/context.d/
├── 10-summary.md
├── 20-open-loops.md
└── 30-decisions.md
```

Use workspace context for active project state, decisions, next actions, and compacted conversation continuity. Do not use it for user-global preferences or durable knowledge. If `.gsv/context.d/` has no loadable files, GSV falls back to `/workspaces/{workspaceId}/.gsv/summary.md` when present.

## Editing Guidance

Agents should treat these paths like normal files. Read before editing, preserve user-authored structure, and keep changes narrow.

Examples:

```sh
mkdir -p ~/context.d
printf '%s\n' '# Current Priorities' > ~/context.d/20-current-priorities.md
mkdir -p /workspaces/my-project/.gsv/context.d
```

Use the GSV target for GSV filesystem paths. Use a device target only when intentionally editing files on that external hardware.

## What Belongs Where

Use `~/context.d/` for concise standing context. Use `/workspaces/{id}/.gsv/context.d/` for active workspace continuity. Use `~/knowledge/` for durable, searchable reference material. Use process context for the current assignment only.
