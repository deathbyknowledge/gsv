# How to Manage Sessions

Sessions hold per-conversation agent state: message history, model settings, and reset policy. Each session runs as a Durable Object with persistent storage.

## List sessions

```bash
gsv session list
```

Shows the most recent sessions sorted by last activity. Limit the count:

```bash
gsv session list --limit 10
```

## Inspect a session

Get session info (settings, status, message count):

```bash
gsv session get agent:main:cli:dm:main
```

Preview the message history:

```bash
gsv session preview agent:main:cli:dm:main
gsv session preview agent:main:cli:dm:main --limit 5
```

View token usage statistics:

```bash
gsv session stats agent:main:cli:dm:main
```

View previous session IDs (from past resets):

```bash
gsv session history agent:main:cli:dm:main
```

## Reset a session

Resetting archives the current conversation to R2 and clears the message history. The agent starts fresh on the next message.

```bash
gsv session reset agent:main:cli:dm:main
```

The default session key is `agent:main:cli:dm:main`, so for the main CLI session you can simply:

```bash
gsv session reset
```

## Compact a session

Compaction trims the conversation to the most recent messages without a full reset. Use this when the context is getting long but you don't want to lose continuity:

```bash
gsv session compact agent:main:cli:dm:main --keep 20
```

Automatic compaction also runs when the conversation approaches the model's context window limit. Configure it via:

```bash
gsv config set compaction.enabled true
gsv config set compaction.reserveTokens 20000
gsv config set compaction.keepRecentTokens 20000
```

When `extractMemories` is enabled, compaction writes durable observations to the daily memory file before trimming.

## Configure auto-reset policies

Auto-reset policies control when sessions automatically clear themselves. Set the default for all new sessions:

```bash
gsv config set session.defaultResetPolicy.mode "daily"
gsv config set session.defaultResetPolicy.atHour 4
```

Available modes:

| Mode | Behavior |
|---|---|
| `manual` | Only reset when explicitly requested |
| `daily` | Reset if the last message was before `atHour` (0-23, default 4) |
| `idle` | Reset after `idleMinutes` of inactivity (default 60) |

Override the policy on a specific session:

```bash
gsv session set agent:main:cli:dm:main resetPolicy.mode "idle"
gsv session set agent:main:cli:dm:main resetPolicy.idleMinutes 30
```

## Override session model settings

Change the model for a specific session without affecting the global config:

```bash
gsv session set agent:main:cli:dm:main model.provider openai
gsv session set agent:main:cli:dm:main model.id gpt-4.1
```

## Understanding session keys

Session keys follow the pattern: `agent:{agentId}:{channel}:{accountId}:dm:{peerId}`

For the CLI, the default is `agent:main:cli:dm:main`.

The `dmScope` config setting controls how much of this key varies across conversations:

- **`main`** (default) -- all DMs collapse into `agent:{agentId}:cli:dm:main`
- **`per-peer`** -- each peer gets `agent:{agentId}:cli:dm:{peerId}`
- **`per-channel-peer`** -- per channel per peer
- **`per-account-channel-peer`** -- fully isolated

Change the scope:

```bash
gsv config set session.dmScope "per-peer"
```

When using `per-peer` or more specific scoping, each distinct conversation partner gets their own session with independent history and reset policy.

## What happens during a reset

1. The current message history is serialized and archived as a gzipped JSONL file in R2 at `agents/{agentId}/sessions/{sessionId}.jsonl.gz`
2. The session's message list is cleared
3. A new session ID is generated
4. On the next inbound message, the agent workspace is reloaded and a fresh conversation begins

The archived session can be retrieved later via the R2 mount or direct R2 access.
