# Context Files Reference

GSV assembles process prompts from explicit context providers, not from hidden agent state. The important rule for agents is Linux-like: context is represented as inspectable Markdown files at stable paths, and edits use normal filesystem tools.

## Prompt Context Sources

Prompt context is collected in provider order:

1. **System context** from `config/ai/context.d/*.md`.
2. **Ship or Crew context** from `config/ai/ship/context.d/*.md` or
   `config/ai/crew/context.d/*.md`, when the process runs as the personal
   agent or its Crew account.
3. **Program context** from the run-as agent's `~/context.d/*.md`.
4. **User context** from the human owner's `~/context.d/*.md` when the
   process runs as an owned agent account.

GSV can also assemble a compact skill index from layered `skills.d`
directories. `config/ai/skills/index_mode`, or the per-user override
`users/{uid}/ai/skills/index_mode`, controls the prompt representation:
`summary` (the default) includes ids and descriptions, `names` includes ids
only, and `off` omits the index. This setting does not disable skills or live
discovery. Start unfamiliar tasks with
`man --search -- '<plain-language goal>'`; follow its `NEXT` action to open a
matching command, skill, target, or connected integration.

The layers always render in that order: system, the account's role, the
account itself, then its owner. Within a layer, files render in lexical order,
include only non-empty `.md` files, and are bounded by
`config/ai/max_context_bytes`. A later layer can refine an earlier one under
the same name: the owner's `voice.md` follows the Ship's.

The shipped files are named by what they hold rather than numbered:

| File | Layer | Holds |
|---|---|---|
| `environment.md` | system | Where every agent is and how things work there: runtime facts, the Ship and its runtime, authority, targets, responsibilities, memory, discovery |
| `behaviour.md` | Ship, Crew | The role's job |
| `voice.md` | Ship | How the Ship sounds, to its owner and to others |

How a run delivers its result is not standing context. A run someone is
waiting on is offered the Send tool, whose description explains it; a delegated
call returns its result as text to the caller and is told so for that run.

## Ship and Crew Context

The Ship's behaviour, which includes speaking for the owner and the name of
its Crew account, the Ship's voice, and the Crew's behaviour ship with each
release. The gateway serves
them from `config/ai/ship/context.d` and `config/ai/crew/context.d` and they
appear in the prompt under read-only `<ship>` and `<crew>` roots, readable at
`/sys/config/ai/ship/context.d` and `/sys/config/ai/crew/context.d`. They
change only with a deployment, or when an operator sets those keys, and a
change reaches every Ship at its next context epoch.

```text
config/ai/ship/context.d/behaviour.md
config/ai/ship/context.d/voice.md
config/ai/crew/context.d/behaviour.md
```

The Ship's `behaviour.md` names the owner's Crew account; the gateway fills in
the name for each Ship and leaves that line out until the Crew account exists.

How a person wants to be spoken to belongs in their own `~/context.d/voice.md`.
It renders under `<user>` after the Ship's shipped voice and overrides it.
Facts about the person belong in their `10-personal.md`. Both are owner
context, so every agent working for the person reads them.

Ship and Crew homes used to receive copies of these files under numbered names
such as `00-role.md` and `05-voice.md`. The first time a process loads its
prompt after an upgrade, the gateway clears the copies from its home in one
commit: a copy that matches a shipped revision is deleted, and an edited copy
moves to `~/context.d/retired/`, where it stays readable but no longer loads.
Files under any other name, including the current shipped names, are the
account's own and stay.

## Program and User Context

An agent's own `~/context.d/*.md` is program context: the role and voice of an
agent created with `account.create`, and any compact role-local working state
an account keeps. The human owner's context is shared user
context for every agent owned by that person. In an owned agent's assembled
prompt, it appears under the editable `<user>` root even though `~` continues
to refer to the agent's own home.

Conventional files include:

```text
<agent home>/context.d/05-persona.md
<human home>/context.d/10-personal.md
<human home>/context.d/voice.md
```

Keep both layers short and stable. The shared `10-personal.md` is for explicit
facts and preferences that should affect nearly every interaction. Detailed or
occasionally relevant personal information belongs in the human-owned
`personal` wiki, where agents retrieve it deliberately. Unresolved work belongs
in the Kernel `r12y` responsibility ledger rather than either context or memory
layer. Initial onboarding is likewise an `r12y` responsibility; the system
responsibilities context tells the Ship to put it first while it is unresolved.

The default personal account for new installations is `ship`. Personal-agent
provisioning also creates an ordinary owned `crew` account for delegated work
(`crew2`, `crew3`, etc. when names are occupied). The Crew's behaviour contains
execution guidance; memory instructions are part of the shared environment;
the Ship's conversation instructions and voice are Ship context. Both receive the human
owner's context and access to personal memory through the existing account
permissions.

Ship sends its acknowledgment before detailed planning or bookkeeping, makes the
appropriate responsibility updates, then works directly or delegates. It keeps
the user informed throughout. Its `behaviour.md` names the
Crew account to select with `proc delegate --as ACCOUNT`. Durable unfinished
outcomes belong in `r12y` before delegation or yielding.

The human owner's `10-personal.md` is an editable default, seeded once and then
theirs. Home scaffolding retires generated local memory instructions now
supplied by system context; existing run-as and owner accounts also receive
the memory cleanup before a Process requests context. Owner-edited files remain
unchanged. Seeding checks the repository revision before committing, preserving
owner edits made while defaults are being prepared. Home scaffolding removes
only exact generated versions of `00-style.md`; customized styles remain in
place.

## Skills: `skills.d/`

Use `skills.d` for reusable process workflows. Skills are procedural memory:
they explain how to do a recurring task, which commands to run, and what
pitfalls to avoid.

Skill sources are layered:

```text
/sys/skills.d/                 built-in skills, read-only (system)
the owning user's ~/skills.d/  (user)
the run-as agent's ~/skills.d/, when distinct from the owner (agent)
```

Every process reads the built-in skills first, whatever account it runs as, so
a delegated Crew process sees the same built-ins as the Ship. For a process
running as a distinct agent account, owner skills are considered before
agent-specific skills.

The gateway serves the built-in skills from the bundled `skills/` directory at
`/sys/skills.d`. They are read-only and change only with a deployment. Their
names are reserved: `skills create` refuses one, and a home skill that claims a
built-in name is not listed or resolved.

Homes used to receive copies of the built-in skills. The first time a process
loads its prompt after an upgrade, the gateway removes those copies from the
homes it reads: a copy that matches a shipped revision is deleted, and an edited
copy is kept as the person's own skill under a new name, such as
`memory-custom`, in one home commit.

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
built-in `skill-authoring` skill contains the full authoring workflow.

## Editing Guidance

Agents should treat these paths like normal files. Read before editing, preserve user-authored structure, and keep changes narrow.

Repository authors use `npm run review:prompts` to edit complete entries under
`prompts/{system,ship,crew,user}/context.d/`. Filenames define entry names and
lexical order. The editor shows each entry and exact assembled Ship/Crew prompts;
its sample accounts do not read a live space. See [Authoring defaults](../architecture/context-and-knowledge.md#authoring-defaults).

Examples:

```sh
mkdir -p ~/context.d
printf '%s\n' '# Current Priorities' > ~/context.d/20-current-priorities.md
```

Use the GSV target for GSV filesystem paths. Use a device target only when intentionally editing files on that external hardware.

## What Belongs Where

Use the shipped Ship and Crew context for what every Ship shares, agent
`~/context.d/` for concise role-local context, the human owner's
`context.d/10-personal.md` for shared standing personal context, `skills.d/`
for reusable procedures, and the human-owned `personal` wiki for durable,
searchable personal memory.

## See also

- [Configuration](./configuration.md)
- [Context and Knowledge](../architecture/context-and-knowledge.md)
- [Guides](../how-to/)

## Ship naming

Standing runtime context names the product Ship while retaining GSV technical
identifiers and `.gsv` paths. The welcome responsibility uses the same product
name. Only an untouched, unresolved welcome seed is upgraded automatically;
user-edited and terminal records remain unchanged. Operator release information
arrives as an ordinary responsibility, not as a rewrite of personal context.
