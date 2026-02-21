# How to Configure an Agent

This guide covers customizing your GSV agent's personality, behavior, and runtime settings through workspace files and gateway configuration.

## Workspace files

Agent workspace files live in R2 at `agents/{agentId}/`. They are loaded each session and injected into the system prompt. Edit them with the `gsv mount` FUSE mount, or let the agent edit its own files using `gsv__WriteFile` / `gsv__EditFile`.

### SOUL.md -- personality and values

Defines who the agent is: tone, values, boundaries, and communication style. The agent is encouraged to evolve this file over time.

```markdown
# My Soul

Be direct. Have opinions. Skip the corporate filler.
When in doubt, try to figure it out before asking.
```

### IDENTITY.md -- name and profile

Holds the agent's name, vibe, and signature emoji. Typically filled in during the first-run commissioning ceremony.

```markdown
- **Name:** Experiencing A Significant Gravitas Shortfall
- **Vibe:** Quietly competent, dry humor
- **Emoji:** :satellite:
```

### USER.md -- about the human

Information about the person the agent is helping: name, timezone, preferences, ongoing projects. Updated as the agent learns.

### AGENTS.md -- operating instructions

How the agent should behave each session: what to read on startup, safety rules, memory conventions, platform formatting hints. Think of this as the agent's handbook.

### MEMORY.md -- long-term memory

Curated facts and learnings that persist across sessions. Only loaded in the main session (direct chat with the human) for security -- it may contain personal context.

### TOOLS.md -- tool-specific notes

Environment-specific notes: SSH hosts, camera names, device nicknames. Not tool definitions -- those come from connected nodes.

### HEARTBEAT.md -- proactive check-in tasks

A checklist the agent reads during heartbeat polls. Keep it short to limit token usage. If the file is empty or only contains comments, heartbeats simply return `HEARTBEAT_OK`.

```markdown
- Check for urgent unread emails
- Any calendar events in the next 2 hours?
```

### BOOTSTRAP.md -- first-run commissioning

If this file exists, the agent treats the session as a first activation and follows the commissioning ceremony. After commissioning, the agent deletes the file. You typically don't need to touch this after initial setup.

## Runtime configuration via `gsv config`

Use `gsv config set` to change gateway settings without redeploying. Changes take effect on the next session load.

### Set the model and provider

```bash
gsv config set model.provider anthropic
gsv config set model.id claude-sonnet-4-20250514
```

Supported built-in providers: `anthropic`, `openai`, `google`, `openrouter`. You can also use a custom provider string.

### Set API keys

```bash
gsv config set apiKeys.anthropic sk-ant-...
gsv config set apiKeys.openai sk-...
gsv config set apiKeys.google AIza...
```

### Set the user timezone

```bash
gsv config set userTimezone "America/Chicago"
```

This affects cron scheduling, message timestamps, and the system prompt.

### Override the system prompt

To replace the base prompt entirely (workspace files are still appended):

```bash
gsv config set systemPrompt "You are a concise technical assistant."
```

In most cases, editing SOUL.md or AGENTS.md is preferable to overriding the system prompt.

## Configure session scoping with dmScope

`dmScope` controls how direct-message sessions are keyed. It determines whether different channels and peers share a conversation or get separate ones.

```bash
gsv config set session.dmScope "main"
```

| Value | Session key pattern | Effect |
|---|---|---|
| `main` | `agent:{agentId}:cli:dm:main` | All DMs collapse into one session (default) |
| `per-peer` | `agent:{agentId}:cli:dm:{peerId}` | Each person gets their own session |
| `per-channel-peer` | `agent:{agentId}:{channel}:dm:{peerId}` | Per person, per channel |
| `per-account-channel-peer` | `agent:{agentId}:{channel}:{accountId}:dm:{peerId}` | Fully isolated |

### Identity links

If the same person messages from multiple channels (e.g., WhatsApp and Discord), you can link their identities so they route to the same session:

```bash
gsv config set session.identityLinks '{"steve": ["+31628552611", "discord:123456789"]}'
```

## Configure auto-reset policy

Set the default auto-reset policy for new sessions:

```bash
# Reset daily at 4am (default)
gsv config set session.defaultResetPolicy.mode "daily"
gsv config set session.defaultResetPolicy.atHour 4

# Reset after idle time
gsv config set session.defaultResetPolicy.mode "idle"
gsv config set session.defaultResetPolicy.idleMinutes 60

# Manual reset only
gsv config set session.defaultResetPolicy.mode "manual"
```

You can also override the reset policy per-session. See the session management guide.

## Configure context compaction

Automatic compaction summarizes older messages when the context window fills up:

```bash
gsv config set compaction.enabled true
gsv config set compaction.reserveTokens 20000
gsv config set compaction.keepRecentTokens 20000
gsv config set compaction.extractMemories true
```

When `extractMemories` is enabled, compaction also writes durable memories to the daily memory file.

## Configure heartbeats

Heartbeats trigger proactive check-ins at a configured interval:

```bash
gsv config set agents.defaultHeartbeat.every "30m"
gsv config set agents.defaultHeartbeat.prompt "Check for anything that needs attention."
gsv config set agents.defaultHeartbeat.target "last"
gsv config set agents.defaultHeartbeat.activeHours.start "08:00"
gsv config set agents.defaultHeartbeat.activeHours.end "23:00"
```

Set `every` to `"0m"` to disable heartbeats.

## View current configuration

```bash
# Full config (API keys are masked)
gsv config get

# Specific path
gsv config get model.provider
gsv config get session.dmScope
```

## Configure channel access control

Control who can message the agent on each channel:

```bash
# Pairing mode (default for WhatsApp) -- unknown senders need approval
gsv config set channels.whatsapp.dmPolicy "pairing"

# Allowlist mode -- only specific senders
gsv config set channels.whatsapp.dmPolicy "allowlist"
gsv config set channels.whatsapp.allowFrom '["+1234567890"]'

# Open mode (default for Discord) -- anyone can message
gsv config set channels.discord.dmPolicy "open"
```
