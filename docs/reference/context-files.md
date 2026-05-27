# Context Files Reference

GSV assembles process prompts from explicit context providers, not from hidden agent state. The important rule for agents is Linux-like: context is represented as inspectable Markdown files at stable paths, and edits use normal filesystem tools.

## Prompt Context Sources

Prompt context is collected in provider order:

1. **System context** from `config/ai/context.d/*.md`.
2. **Profile context** from `config/ai/profile/{profile}/context.d/*.md` or a user profile under `~/profiles.d/{profile}/context.d/*.md`.
3. **Home context** from `~/context.d/*.md`.
4. **Process context** supplied by the current assignment or runtime.

GSV also assembles a compact skill index from layered `skills.d` directories.
The prompt lists skill ids and descriptions only. Use `skills list`,
`skills search <query>`, and `skills show <skill>` to inspect full skill bodies.

System context is operator-managed runtime guidance shared by every profile. Built-in profile files are operator-managed instructions for roles such as `init`/`personal`, `task`, `review`, `cron`, `mcp`, and `app`. User profile context files under `~/profiles.d/{name}/context.d/*.md` add filesystem-backed worker specializations that can be spawned directly or used by automation. Other files in `~/profiles.d/{name}` are available to the profile but are not loaded as profile prompt context. Context files may use template keys such as `identity.home`, `identity.cwd`, `devices`, and `mcpServers`.

Home context files are loaded lexically, include only non-empty `.md` files, and are bounded by `config/ai/max_context_bytes`.

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
config/ai/profile/{profile}/skills.d/
~/skills.d/
/src/packages/{package}/skills.d/
```

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
writable. Package skills follow package source rules: writable package edits are
staged until `pkg source commit`.

## Editing Guidance

Agents should treat these paths like normal files. Read before editing, preserve user-authored structure, and keep changes narrow.

Examples:

```sh
mkdir -p ~/context.d
printf '%s\n' '# Current Priorities' > ~/context.d/20-current-priorities.md
```

Use the GSV target for GSV filesystem paths. Use a device target only when intentionally editing files on that external hardware.

## What Belongs Where

Use `~/context.d/` for concise standing context. Use `skills.d/` for reusable procedures. Use `~/knowledge/` for durable, searchable reference material. Use process context for the current assignment only.
