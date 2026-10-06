# Context Files Reference

GSV assembles process prompts from explicit context providers, not from hidden agent state. The important rule for agents is Linux-like: context is represented as inspectable Markdown files at stable paths, and edits use normal filesystem tools.

## Prompt Context Sources

Prompt context is collected in provider order:

1. **System context** from `config/ai/context.d/*.md`.
2. **Program context** from the run-as agent's `~/context.d/*.md`.
3. **User context** from the human owner's `~/context.d/*.md` when the
   process runs as an owned agent account.

GSV can also assemble a compact skill index from layered `skills.d`
directories. `config/ai/skills/index_mode`, or the per-user override
`users/{uid}/ai/skills/index_mode`, controls the prompt representation:
`summary` (the default) includes ids and descriptions, `names` includes ids
only, and `off` omits the index. This setting does not disable skills or live
discovery. Start unfamiliar tasks with
`man --search -- '<plain-language goal>'`; follow its `NEXT` action to open a
matching command, skill, target, or connected integration.

Context files are loaded lexically within each layer, include only non-empty
`.md` files, and are bounded by `config/ai/max_context_bytes`.

## Program and User Context

An agent's own `~/context.d/*.md` is program context: its role, voice, and
compact role-local working state. The human owner's context is shared user
context for every agent owned by that person. In an owned agent's assembled
prompt, it appears under the editable `<user>` root even though `~` continues
to refer to the agent's own home.

Conventional files include:

```text
<agent home>/context.d/00-role.md
<agent home>/context.d/05-voice.md
<personal agent home>/context.d/10-delegation.md
<human home>/context.d/10-personal.md
```

Keep both layers short and stable. The shared `10-personal.md` is for explicit
facts and preferences that should affect nearly every interaction. Detailed or
occasionally relevant personal information belongs in the human-owned
`personal` wiki, where agents retrieve it deliberately. Unresolved work belongs
in the Kernel `r12y` responsibility ledger rather than either context or memory
layer. Initial onboarding is likewise an `r12y` responsibility, not a generated
context file; the system responsibilities context tells the Ship to put it first
while it is unresolved.

The default personal account for new installations is `ship`. Personal-agent
provisioning also creates an ordinary owned `crew` account for delegated work
(`crew2`, `crew3`, etc. when names are occupied). Its own `context.d` contains
execution and memory guidance; Ship's conversation instructions and voice stay
in Ship's home. Both receive the human owner's context and access to personal
memory through the existing account permissions.

Ship sends its acknowledgment before detailed planning or bookkeeping, makes the
appropriate responsibility updates, then works directly or delegates. It keeps
the user informed throughout. Its `10-delegation.md` names the
Crew account to select with `proc delegate --as ACCOUNT`. Durable unfinished
outcomes belong in `r12y` before delegation or yielding.

These are editable account defaults. Existing account names and customized context files
are preserved; revised prompt text seeds missing files, without rewriting an
existing account's instructions. To adopt the new defaults in an existing
space, edit that account's context files deliberately.
Seeding checks the repository revision before committing, preserving owner
edits made while defaults are being prepared.
Generic style files are no longer seeded. Home scaffolding removes only exact
generated versions of `00-style.md`; customized styles remain in place.

## Skills: `skills.d/`

Use `skills.d` for reusable process workflows. Skills are procedural memory:
they explain how to do a recurring task, which commands to run, and what
pitfalls to avoid.

Skill sources are layered:

```text
the owning user's ~/skills.d/
the run-as agent's ~/skills.d/, when distinct from the owner
```

For a process running as a distinct agent account, owner skills are considered
before agent-specific skills.

The gateway ships built-in skills as text modules. `sys.bootstrap` seeds them
into the bootstrapped user's `~/skills.d/`. Prompt configuration also
restores missing built-in skill paths before collecting the skill index.
Existing and customized files are never overwritten.

Supported forms:

```text
skills.d/device-management.md
skills.d/device-management/SKILL.md
skills.d/device-management/references/details.md
```

Processes should use `skills show <skill>` before relying on a workflow.
That command prints the full `SKILL.md`, source path, and whether the source is
writable.

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

## Editing Guidance

Agents should treat these paths like normal files. Read before editing, preserve user-authored structure, and keep changes narrow.

Repository authors use `npm run review:prompts` to edit the shipped Markdown by
category: world model, interaction, computer/discovery, durable work, knowledge,
role/judgment, voice, and instance facts. These authoring categories compose into
the existing `context.d` paths above. The editor shows both the category sources
and exact assembled Ship/Crew prompts; its sample accounts do not read a live
space. See [Authoring defaults](../architecture/context-and-knowledge.md#authoring-defaults).

Examples:

```sh
mkdir -p ~/context.d
printf '%s\n' '# Current Priorities' > ~/context.d/20-current-priorities.md
```

Use the GSV target for GSV filesystem paths. Use a device target only when intentionally editing files on that external hardware.

## What Belongs Where

Use agent `~/context.d/` for concise role-local context, the human owner's
`context.d/10-personal.md` for shared standing personal context, `skills.d/`
for reusable procedures, and the human-owned `personal` wiki for durable,
searchable personal memory.

## See also

- [Configuration](./configuration.md)
- [Context and Knowledge](../architecture/context-and-knowledge.md)
- [Guides](../how-to/)
