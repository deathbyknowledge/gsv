# Context Files Reference

GSV assembles process prompts from explicit context providers, not from hidden agent state. The important rule for agents is Linux-like: context is represented as inspectable Markdown files at stable paths, and edits use normal filesystem tools.

## Prompt Context Sources

Prompt context is collected in provider order:

1. **System context** from `config/ai/context.d/*.md`.
2. **Profile context** from `config/ai/profile/{profile}/context.d/*.md`.
3. **Home context** from `~/context.d/*.md`.
4. **Workspace context** from `/workspaces/{workspaceId}/.gsv/context.d/*.md`, when the process has a workspace.
5. **Process context** supplied by the current assignment or runtime.

GSV can also assemble a compact skill index from layered `skills.d`
directories. `config/ai/skills/index_mode`, or the per-user override
`users/{uid}/ai/skills/index_mode`, controls the prompt representation:
`summary` (the default) includes ids and descriptions, `names` includes ids
only, and `off` omits the index. This setting does not disable skills or live
discovery. Start unfamiliar tasks with
`man --search -- '<plain-language goal>'`; follow its `NEXT` action to open a
matching command, skill, target, or connected integration.

System context is operator-managed runtime guidance shared by every profile. Profile files are operator-managed instructions for roles such as `task`, `review`, `cron`, `mcp`, and `app`. They may use template keys such as `identity.home`, `workspace`, `devices`, `mcpServers`, and `known_paths`.

Home and workspace context files are loaded lexically, include only non-empty `.md` files, and are bounded by `config/ai/max_context_bytes`.

## Home Context: `~/context.d/`

Use `~/context.d/*.md` for small, curated user-global notes that should be available to most processes. This is for standing context, not raw logs or a private database.

Good examples:

```text
~/context.d/00-constitution.md
~/context.d/10-user.md
~/context.d/20-current-priorities.md
```

Keep these files short and stable. Put durable reference material under `~/knowledge/` instead, where it can be searched and retrieved deliberately.

## Skills: `skills.d/`

Use `skills.d` for reusable process workflows. Skills are procedural memory:
they explain how to do a recurring task, which commands to run, and what
pitfalls to avoid.

Skill sources are layered:

```text
the owning user's ~/skills.d/
the run-as agent's ~/skills.d/, when distinct from the owner
visible enabled package source repos, resolved with `pkg source <package>`
```

For a process running as a distinct agent account, owner skills are considered
before agent-specific skills. Profile and workspace context directories affect
prompt context, but they are not skill discovery roots.

The root GSV source repo can ship system skills under `skills/`. During
`sys.bootstrap`, those files are copied into each bootstrapped user's
`~/skills.d/` when missing. Existing user skills are preserved.

Supported forms:

```text
skills.d/package-development.md
skills.d/package-development/SKILL.md
skills.d/package-development/references/details.md
```

Processes should use `skills show <skill>` before relying on a workflow.
That command prints the full `SKILL.md`, source path, and whether the source is
writable. Package skills follow repo source rules: writable package edits are
staged until `rgit commit`.

When a user asks to automate, save, or reuse a proven workflow, draft a concise
Markdown instruction body and persist it through the existing home filesystem:

```sh
skills create <name> --description '<what it does and when to use it>' --from <body-file>
skills validate <name>
skills show <name>
```

Creation writes `~/skills.d/<name>/SKILL.md` and refuses to overwrite an
existing skill. Read the current skill first and pass `--replace` only for an
intentional revision. Do not silently persist one-off workflows, credentials,
private content, or transient account, message, and target identifiers. The
seeded `skill-authoring` skill contains the full authoring workflow.

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

Use `~/context.d/` for concise standing context. Use `/workspaces/{id}/.gsv/context.d/` for active workspace continuity. Use `skills.d/` for reusable procedures. Use `~/knowledge/` for durable, searchable reference material. Use process context for the current assignment only.

## See also

- [Configuration](./configuration.md)
- [Context and Knowledge](../architecture/context-and-knowledge.md)
- [Guides](../how-to/)
