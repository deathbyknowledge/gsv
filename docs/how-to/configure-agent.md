# How to Configure an Agent

GSV agents run as processes. Their behavior comes from runtime config, profile
context, home context, process history, assignment context, and available
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
gsv config set users/1000/ai/generation/timeout_ms 180000
```

Generation streaming is a system operational switch. It defaults to `auto`; root can disable stream deltas while preserving final responses:

```bash
gsv config set config/ai/generation/streaming off
```

Sensitive keys such as `api_key`, `token`, `secret`, and `password` are hidden
from non-root system config reads.

Voice transcription uses the shared `ai.transcription.create` path. Configure
it independently from the chat model when needed:

```bash
gsv config set config/ai/transcription/model @cf/openai/whisper-large-v3-turbo
gsv config set config/ai/transcription/max_bytes 26214400
```

Voice replies use the shared `ai.speech.create` path and default to Workers AI
TTS. Speech text is treated as Markdown by default and normalized before synthesis;
callers that need literal text can pass `textFormat: "plain"`:

```bash
gsv config set config/ai/speech/model @cf/deepgram/aura-2-en
gsv config set config/ai/speech/speaker luna
gsv config set config/ai/speech/encoding mp3
gsv config set config/ai/speech/timeout_ms 30000
```

## Edit System and Profile Context

System context applies to every process profile:

```text
config/ai/context.d/*.md
```

Profiles define role-level behavior for process types such as `init`, `task`,
`review`, `cron`, `mcp`, and `app`. Profile context is stored as Markdown
fragments:

```text
config/ai/profile/{profile}/context.d/*.md
```

Use numeric prefixes to control order:

```bash
gsv config set config/ai/context.d/50-local-runtime.md \
  "Use the native gsv target for files in the GSV cloud computer."

gsv config set config/ai/profile/task/context.d/50-style.md \
  "Be direct, inspect files before editing, and explain risky changes first."
```

The user-facing default is the persistent personal agent, implemented by the
`init` profile and accepted as `personal` by process spawning surfaces. Use
`task` for bounded delegated workers rather than for the long-lived personal
front door.

Users can add worker specializations under their home profile directory:

```text
~/profiles.d/{name}/profile.json
~/profiles.d/{name}/description.md
~/profiles.d/{name}/context.d/*.md
~/profiles.d/{name}/tools/approval
```

These profiles are filesystem-backed and can carry ordinary files or symbolic
links. Put prompt instructions in non-empty Markdown files under `context.d`;
root-level files are available to the worker but are not loaded as prompt
context. `profile.json` is optional; if omitted, GSV derives the display name
from the directory name. Spawn profiles directly:

```bash
gsv proc spawn --profile research --prompt "Audit the week of notes."
```

System and profile context can use runtime template variables such as
`identity.username`, `identity.home`, `identity.cwd`, `devices` and
`mcpServers`.

## Add Home Context

Home context applies across a user's processes:

```text
~/context.d/*.md
```

Use home context for durable preferences and recurring operating notes. Put
project-specific instructions, status, and handoff notes in explicit project
files, package source, or process assignment context. Keep always-loaded context
short and focused; the runtime loads home files lexically until
`config/ai/max_context_bytes` is reached.

## Configure Tool Approval

Tool approval is profile-specific JSON:

```text
config/ai/profile/{profile}/tools/approval
```

Example policy:

```bash
gsv config set config/ai/profile/task/tools/approval \
  '{"default":"auto","rules":[{"match":"shell.exec","when":{"anyTag":["destructive","privileged"]},"action":"ask"},{"match":"fs.delete","action":"ask"},{"match":"sys.mcp.call","action":"ask"},{"match":"fs.*","when":{"target":"device"},"action":"ask"}]}'
```

Rules match exact syscalls or domain wildcards such as `fs.*`. Conditions can
filter by profile, tags, argument prefixes, and target type (`gsv` or `device`).
Interactive profiles can pause for approval; non-interactive profiles such as
`cron` turn `ask` decisions into tool errors.

## Expose Devices Deliberately

Connected devices appear in process context and tool schemas. Agents always see
the same tool names (`Read`, `Write`, `Edit`, `Delete`, `Search`, `Shell`);
`target` selects where the syscall runs.

Give devices short notes in **GSV > Devices** so agents see why a target exists,
not just its id and platform. For example, describe `rearden` as a Linux home
server for GPU work or home automation if that is the routing intent.

Use profile or home context to tell agents when a device should be used:

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
