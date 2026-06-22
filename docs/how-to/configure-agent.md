# How to Configure an Agent

GSV agents run as accounts that own process behavior. Their behavior comes from
runtime config, account home context, owner home context, process history,
assignment context, and available syscall tools. Configure the durable inputs
rather than editing a hidden prompt.

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

## Edit System and Agent Context

System context applies to every agent run:

```text
config/ai/context.d/*.md
```

Agent-specific context is stored in the run-as account home:

```text
~/context.d/*.md
```

Use numeric prefixes to control order:

```bash
gsv config set config/ai/context.d/50-local-runtime.md \
  "Use the native gsv target for files in the GSV cloud computer."
```

Use the GSV Agents section or normal filesystem tools to edit a runnable
agent's `~/context.d/*.md` files. Spawn a process as a runnable account:

```bash
gsv proc spawn --as research-agent --prompt "Audit the week of notes."
```

System and agent context can use runtime template variables such as
`current.date`, `current.timezone`, `identity.username`, `identity.home`,
`identity.cwd`, `devices`, and `mcpServers`.

Keep `context.d` concise. For long-term searchable memory, create or use the
agent's repo-backed `memory` wiki:

```bash
wiki db init memory --title "research-agent Memory"
```

After initialization, pages are normal markdown files in the agent-owned repo:

```text
/src/repos/research-agent/memory/index.md
/src/repos/research-agent/memory/pages/
/src/repos/research-agent/memory/pages/journal/YYYY/MM/YYYY-MM-DD.md
```

Agents should search and edit those files for durable facts, decisions,
preferences, journal entries, closed-loop history, and supporting evidence. Keep
active commitments, unresolved questions, blockers, and follow-ups in
`~/context.d/20-open-loops.md` when they must be loaded into every prompt.

## Add Owner Context

Agent context applies across processes running as that account. The owning
human's `~/context.d/*.md` is layered in separately as owner context when those
files exist:

```text
~/context.d/*.md
```

Use home context for compact recurring operating notes. Put durable preferences,
project-specific instructions, status, and handoff notes in a wiki, explicit
project files, package source, or process assignment context. Keep always-loaded context
short and focused; the runtime loads context files lexically until
`config/ai/max_context_bytes` is reached.

## Configure Tool Approval

Tool approval is account-specific JSON:

```text
users/{uid}/ai/tools/approval
```

Example policy:

```bash
gsv config set users/1001/ai/tools/approval \
  '{"default":"auto","rules":[{"match":"shell.exec","when":{"anyTag":["destructive","privileged"]},"action":"ask"},{"match":"fs.delete","action":"ask"},{"match":"sys.mcp.call","action":"ask"},{"match":"fs.*","when":{"target":"device"},"action":"ask"}]}'
```

Rules match exact syscalls or domain wildcards such as `fs.*`. Conditions can
filter by tags, argument prefixes, and target type (`gsv` or `device`).
Interactive processes can pause for approval; non-interactive background
processes turn `ask` decisions into tool errors.

## Expose Devices Deliberately

Connected devices appear in process context and tool schemas. Agents always see
the same tool names (`Read`, `Write`, `Edit`, `Delete`, `Search`, `Shell`);
`target` selects where the syscall runs.

Give devices short notes in **GSV > Devices** so agents see why a target exists,
not just its id and platform. For example, describe `rearden` as a Linux home
server for GPU work or home automation if that is the routing intent.

Use system, owner, or agent home context to tell agents when a device should be
used:

```markdown
Use `target: "gsv"` for Kernel files and package state.
Use `target: "macbook"` only for the local checkout under ~/projects/gsv.
```

## Inspect Effective State

Useful checks while tuning behavior:

```bash
gsv proc list
gsv proc history --limit 20
gsv config get users/1001/ai
gsv chat "List your available devices and current working context."
```

Changes to AI config and context are picked up at the start of the next process
run. Reset a process when you want a clean history with the new context:

```bash
gsv proc reset
```
