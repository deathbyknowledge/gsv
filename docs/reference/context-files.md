# Context Files Reference

GSV assembles process prompts from explicit context providers, not from hidden agent state. The important rule for agents is Linux-like: context is represented as inspectable Markdown files at stable paths, and edits use normal filesystem tools.

## Prompt Context Sources

Prompt context is collected in provider order:

1. **System context** from `config/ai/context.d/*.md`.
2. **Agent home context** from the run-as account's `~/context.d/*.md`.
3. **Owner context** from the owning human's `~/context.d/*.md` when distinct.
4. **Process context** supplied by the current assignment or runtime.

GSV also assembles a compact skill index from layered `skills.d` directories.
The prompt lists top-level skill descriptions only. Nested skills are disclosed
on demand with `skills list <skill>`, `skills tree <skill>`,
`skills search <query>`, and `skills show <skill>`.

System context is operator-managed runtime guidance shared by every process.
Agent context files add account-specific behavior and preferences. Owner
context is available for human-authored notes; human homes start with an empty
`~/context.d/` directory.
Context files may use template keys such as `identity.home`, `identity.cwd`,
`devices`, and `mcpServers`.

Prompt context roots are rendered with prompt-markup tags such as
`<system path="/sys/config/ai/context.d/">`, `<user path="/home/alice/context.d/">`,
and `<program path="/home/agent/context.d/">`. Each context file is rendered
inside a filename tag.

Home context files are loaded lexically, include only non-empty `.md` files, and are bounded by `config/ai/max_context_bytes`.

## Home Context: `~/context.d/`

Use `~/context.d/*.md` for small, curated notes that should be available to most processes running as that account. This is for standing context, not raw logs or a private database.

Good examples:

```text
~/context.d/00-style.md
~/context.d/10-user.md
~/context.d/20-current-priorities.md
```

New human homes create the directory only. New agent homes seed short style,
memory, and user identity files. New personal agents also seed a one-time
`00-boot.md` onboarding file, which the agent should delete after setup is
done. Keep these files short and stable.

Agent long-term memory belongs in a repo-backed wiki, conventionally the
agent-owned `memory` wiki. After creation it is available as normal markdown
under:

```text
/src/repos/<agent>/memory/index.md
/src/repos/<agent>/memory/pages/
/src/repos/<agent>/memory/pages/journal/YYYY/MM/YYYY-MM-DD.md
```

Create the wiki with `wiki db init memory --title "<agent> Memory"`, then use
filesystem search/read/write/edit for page work. Put durable reference material
there, where it can be searched and retrieved deliberately.

## Skills: `skills.d/`

Use `skills.d` for reusable process workflows. Skills are procedural memory:
they explain how to do a recurring task, which commands to run, and what
pitfalls to avoid.

Skill sources are layered:

```text
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
skills.d/package-development/skills.d/create-package/SKILL.md
skills.d/package-development/references/details.md
```

Processes should use `skills show <skill>` before relying on a workflow.
That command prints the full `SKILL.md`, source path, and whether the source is
writable. Package skills follow package source rules: writable package edits are
staged until `pkg source commit`.

Nested skills live under a parent skill's own `skills.d/`. The parent
`SKILL.md` is prompt-visible; its nested children are not included in prompt
assembly and must be loaded explicitly. Frontmatter supports `name`,
`description`, and optional `aliases`; hierarchy comes from the filesystem.

## Editing Guidance

Agents should treat these paths like normal files. Read before editing, preserve user-authored structure, and keep changes narrow.

Examples:

```sh
mkdir -p ~/context.d
printf '%s\n' '# Current Priorities' > ~/context.d/20-current-priorities.md
```

Use the GSV target for GSV filesystem paths. Use a device target only when intentionally editing files on that external hardware.

## What Belongs Where

Use `~/context.d/` for concise standing context. Use `skills.d/` for reusable procedures. Use Wiki for durable, searchable reference material and agent memory. Use process context for the current assignment only.
