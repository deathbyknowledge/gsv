# How to Configure an Agent

GSV agents run as processes. Their behavior comes from runtime config, profile
context, home context, workspace context, process history, and available
syscall tools. Configure the durable inputs rather than editing a hidden prompt.

## Set AI Runtime Defaults

System defaults live under `config/ai/*`. Per-user overrides live under
`users/{uid}/ai/*` and win over system defaults for that user.

```bash
gsv config get config/ai
gsv config set config/ai/provider openrouter
gsv config set config/ai/model openai/gpt-4.1
gsv config set config/ai/api_key "$OPENROUTER_API_KEY"
```

Non-root users can set only their own `users/{uid}/ai/*` keys:

```bash
gsv config set users/1000/ai/model gpt-4.1-mini
gsv config set users/1000/ai/max_context_bytes 65536
```

Sensitive keys such as `api_key`, `token`, `secret`, and `password` are hidden
from non-root system config reads.

## Edit Profile Context

Profiles define role-level behavior for process types such as `init`, `task`,
`review`, `cron`, `mcp`, `app`, `archivist`, and `curator`. Profile context is
stored as Markdown fragments:

```text
config/ai/profile/{profile}/context.d/*.md
```

Use numeric prefixes to control order:

```bash
gsv config set config/ai/profile/task/context.d/50-style.md \
  "Be direct, inspect files before editing, and explain risky changes first."
```

Profile context can use runtime template variables such as
`identity.username`, `identity.home`, `identity.cwd`, `identity.workspaceId`,
`workspace`, `devices`, and `known_paths`.

## Add Home and Workspace Context

Home context applies across a user's processes:

```text
~/context.d/*.md
```

Workspace context applies only when a process is attached to a workspace:

```text
/workspaces/{workspaceId}/.gsv/context.d/*.md
```

Use home context for durable preferences and recurring operating notes. Use
workspace context for project-specific instructions, status, and handoff notes.
Keep files short and focused; the runtime loads them lexically until
`config/ai/max_context_bytes` is reached.

## Configure Tool Approval

Tool approval is profile-specific JSON:

```text
config/ai/profile/{profile}/tools/approval
```

Example policy:

```bash
gsv config set config/ai/profile/task/tools/approval \
  '{"default":"auto","rules":[{"match":"shell.exec","action":"ask"},{"match":"fs.delete","action":"ask"},{"match":"fs.*","when":{"target":"device"},"action":"ask"}]}'
```

Rules match exact syscalls or domain wildcards such as `fs.*`. Conditions can
filter by profile, tags, argument prefixes, and target type (`gsv` or `device`).
Interactive profiles can pause for approval; non-interactive profiles such as
`cron`, `archivist`, and `curator` turn `ask` decisions into tool errors.

## Expose Devices Deliberately

Connected devices appear in process context and tool schemas. Agents always see
the same tool names (`Read`, `Write`, `Edit`, `Delete`, `Search`, `Shell`);
`target` selects where the syscall runs.

Use profile or workspace context to tell agents when a device should be used:

```markdown
Use `target: "gsv"` for Kernel files and package state.
Use `target: "macbook"` only for the local checkout under ~/projects/gsv.
```

## Inspect Effective State

Useful checks while tuning behavior:

```bash
gsv proc list
gsv proc history --limit 20
gsv config get config/ai/profile/task
gsv chat "List your available devices and current working context."
```

Changes to AI config and context are picked up at the start of the next process
run. Reset a process when you want a clean history with the new context:

```bash
gsv proc reset
```
