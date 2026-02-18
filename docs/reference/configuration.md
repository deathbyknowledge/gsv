# Configuration Reference

GSV configuration is a JSON object stored in the Gateway Durable Object. Configuration is applied by deep-merging user-provided overrides onto the default configuration. Arrays and primitives in overrides replace defaults; objects are merged recursively.

The full configuration type is `GsvConfig` (defined in `gateway/src/config/index.ts`). Defaults are in `gateway/src/config/defaults.ts`.

---

## Model

Top-level model settings used by the agent LLM loop. Per-agent overrides are available via `agents.list[].model`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model.provider` | `string` | `"anthropic"` | LLM provider identifier. Used for API routing. |
| `model.id` | `string` | `"claude-sonnet-4-20250514"` | Model identifier passed to the provider API. |

---

## API Keys

Provider API keys. Stored as worker secrets or in config. All keys are optional; only the key for the active provider is required at runtime.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `apiKeys.anthropic` | `string` | `undefined` | Anthropic API key. |
| `apiKeys.openai` | `string` | `undefined` | OpenAI API key. |
| `apiKeys.google` | `string` | `undefined` | Google AI API key. |
| `apiKeys.openrouter` | `string` | `undefined` | OpenRouter API key. |

---

## Timeouts

Timeout durations for LLM calls and tool execution.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `timeouts.llmMs` | `number` | `300000` (5 min) | Maximum duration in milliseconds for a single LLM API call. |
| `timeouts.toolMs` | `number` | `60000` (1 min) | Maximum duration in milliseconds for a single tool execution. |
| `timeouts.skillProbeMaxAgeMs` | `number` | `600000` (10 min) | Maximum age in milliseconds for cached skill binary probe results. Optional. |

---

## Auth

Authentication settings for client/node WebSocket connections.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `auth.token` | `string` | `undefined` | Shared secret token for authenticating WebSocket clients and nodes. Optional. |

---

## Transcription

Audio-to-text transcription settings for voice messages received from channels.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `transcription.provider` | `"workers-ai" \| "openai"` | `"workers-ai"` | Transcription provider. |

---

## System Prompt

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `systemPrompt` | `string` | `undefined` | Default system prompt base text for all agents. When unset, the built-in default is used: `"You are a helpful AI assistant running inside GSV."` Per-agent overrides are available via `agents.list[].systemPrompt`. |

---

## User Timezone

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `userTimezone` | `string` | `"UTC"` | IANA timezone string (e.g. `"America/Chicago"`, `"Europe/Amsterdam"`). Used in message envelopes, cron scheduling, heartbeat active-hours evaluation, and the system prompt runtime section. |

---

## Channels

Per-channel access control and DM policy settings. Each key in the `channels` object is a channel name (e.g. `"whatsapp"`, `"discord"`).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `channels.<name>.dmPolicy` | `"open" \| "allowlist" \| "pairing"` | See below | DM access policy for the channel. |
| `channels.<name>.allowFrom` | `string[]` | `[]` | List of allowed sender IDs. Supports E.164 phone numbers, WhatsApp JIDs, and a `"*"` wildcard. |

### Default Channel Configuration

| Channel | `dmPolicy` | `allowFrom` |
|---------|-----------|-------------|
| `whatsapp` | `"pairing"` | `[]` |
| `discord` | `"open"` | `[]` |

Channels not listed in the config default to allowing all senders.

### DM Policy Values

| Value | Behavior |
|-------|----------|
| `"open"` | Any sender can message. No access control. |
| `"allowlist"` | Only senders in `allowFrom` can message. Others are silently blocked. |
| `"pairing"` | Senders in `allowFrom` can message. Unknown senders trigger a pairing request that must be approved via CLI. |

### Sender ID Normalization

Sender IDs are normalized to E.164 format for comparison. WhatsApp JID suffixes (`@s.whatsapp.net`, `@c.us`), device suffixes (`:0`), and non-digit characters are stripped. A `+` prefix is added to numbers with 10 or more digits.

---

## Session

Session lifecycle and routing configuration.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `session.defaultResetPolicy.mode` | `"manual" \| "daily" \| "idle"` | `"daily"` | Auto-reset mode for new sessions. |
| `session.defaultResetPolicy.atHour` | `number` | `4` | Hour of day (0-23) for `"daily"` mode reset. |
| `session.defaultResetPolicy.idleMinutes` | `number` | `undefined` | Minutes of inactivity before reset in `"idle"` mode. |
| `session.mainKey` | `string` | `"main"` | Canonical session key for the per-agent main session. |
| `session.dmScope` | `DmScope` | `"main"` | How direct-message sessions are keyed. See DM Scope values below. |
| `session.identityLinks` | `Record<string, string[]>` | `{}` | Maps canonical names to arrays of channel identity strings. Used to route multiple channel identities to a single session. |

### DM Scope Values

| Value | Behavior |
|-------|----------|
| `"main"` | All DMs route to the main session. |
| `"per-peer"` | Each peer gets a separate session. |
| `"per-channel-peer"` | Each channel+peer combination gets a separate session. |
| `"per-account-channel-peer"` | Each account+channel+peer combination gets a separate session. |

### Identity Links

Identity links map multiple channel identities to a canonical name for session routing. Keys are canonical names; values are arrays of identity strings.

Identity strings may be:
- A bare phone number: `"+31628552611"` — matches any channel after E.164 normalization.
- A channel-prefixed identifier: `"telegram:123456789"` — matches only the specified channel. Channel name comparison is case-insensitive.

---

## Skills

Skill availability and runtime eligibility overrides.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `skills.entries` | `Record<string, SkillEntryConfig>` | `{}` | Per-skill policy entries, keyed by skill name, directory key, or location path. |

### SkillEntryConfig

Each entry in `skills.entries` configures a single skill.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `undefined` | Hard toggle. When `false`, the skill is hidden from the prompt. When `undefined` or `true`, default visibility rules apply. |
| `always` | `boolean` | `undefined` | Overrides skill frontmatter `always` flag. When `true`, the skill is always included regardless of runtime requirements. |
| `requires` | `SkillRequirementsConfig` | `undefined` | Overrides skill frontmatter runtime requirements. |

### SkillRequirementsConfig

| Key | Type | Description |
|-----|------|-------------|
| `hostRoles` | `string[]` | Restrict to hosts with these roles (`"execution"`, `"specialized"`). |
| `capabilities` | `string[]` | Require all listed capabilities on the same host. Valid values: `"filesystem.list"`, `"filesystem.read"`, `"filesystem.write"`, `"filesystem.edit"`, `"text.search"`, `"shell.exec"`. |
| `anyCapabilities` | `string[]` | Require at least one of these capabilities on the same host. Same valid values as `capabilities`. |
| `bins` | `string[]` | Require all listed binaries to be available (probe status `true`) on the selected host. |
| `anyBins` | `string[]` | Require at least one of these binaries on the selected host. |
| `env` | `string[]` | Require all listed environment variable keys on the selected host. |
| `config` | `string[]` | Require all dotted config paths to resolve to non-empty values in the runtime config. |
| `os` | `string[]` | Restrict to hosts matching one of these OS identifiers (e.g. `"darwin"`, `"linux"`). Comparison is case-insensitive. |

---

## Agents

Multi-agent configuration: agent definitions, channel-to-agent bindings, and default heartbeat settings.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agents.list` | `AgentConfig[]` | `[]` | List of agent configurations. |
| `agents.bindings` | `AgentBinding[]` | `[]` | Rules mapping channels/chats to specific agents. |
| `agents.defaultHeartbeat` | `HeartbeatConfig` | See below | Default heartbeat configuration applied to all agents. |

### AgentConfig

Each entry in `agents.list` defines an agent.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `id` | `string` | — | Agent identifier. Required. |
| `default` | `boolean` | `false` | Whether this is the default agent. The first agent with `default: true` is used when no binding matches. If no agent is marked default, `"main"` is used. |
| `model.provider` | `string` | Inherits top-level `model.provider` | LLM provider override for this agent. |
| `model.id` | `string` | Inherits top-level `model.id` | Model ID override for this agent. |
| `systemPrompt` | `string` | Inherits top-level `systemPrompt` | System prompt base text override for this agent. |
| `heartbeat` | `HeartbeatConfig` | Inherits `agents.defaultHeartbeat` | Heartbeat configuration override for this agent. |

### AgentBinding

Bindings route inbound channel messages to a specific agent based on match criteria. Bindings are evaluated in order; the first match wins.

| Key | Type | Description |
|-----|------|-------------|
| `agentId` | `string` | Agent ID to route to. Required. |
| `match.channel` | `string` | Channel name to match (e.g. `"whatsapp"`, `"discord"`). Optional. |
| `match.accountId` | `string` | Account ID to match (for multi-account channels). Optional. |
| `match.peer.kind` | `"dm" \| "group"` | Peer kind to match. Optional. |
| `match.peer.id` | `string` | Peer ID to match. Optional. |

All `match` fields are optional. Omitted fields match any value.

### HeartbeatConfig

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `every` | `string` | `"30m"` | Interval between heartbeats. Duration string (e.g. `"30m"`, `"1h"`, `"2h30m"`). `"0"` or `"0m"` disables heartbeats. |
| `prompt` | `string` | `"Read HEARTBEAT.md if it exists in your workspace. Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK."` | Custom prompt injected when a heartbeat fires. |
| `target` | `"last" \| "none" \| string` | `"last"` | Delivery target for heartbeat responses. `"last"` sends to the last active channel. `"none"` discards the response. Any other string is treated as a specific channel name. |
| `activeHours.start` | `string` | `"08:00"` | Start of active hours in `HH:MM` format. Heartbeats are skipped outside active hours. |
| `activeHours.end` | `string` | `"23:00"` | End of active hours in `HH:MM` format. |
| `activeHours.timezone` | `string` | `undefined` | Timezone for active hours evaluation. `"user"` uses `userTimezone`, `"local"` uses system local time, or specify an IANA zone. Optional. |

### Duration String Format

Duration strings support hours (`h`), minutes (`m`), and seconds (`s`) components. They can be combined: `"2h30m"`, `"1h"`, `"30m"`, `"90s"`. The value `"0"` or `"0m"` parses to 0 milliseconds.

---

## Compaction

Automatic context compaction settings. Compaction summarizes older messages when the conversation approaches the model's context window limit.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `compaction.enabled` | `boolean` | `true` | Whether automatic context compaction is enabled. |
| `compaction.reserveTokens` | `number` | `20000` | Token headroom reserved below the context window for the model's response and system prompt. |
| `compaction.keepRecentTokens` | `number` | `20000` | Estimated token budget for recent messages kept verbatim (not summarized). |
| `compaction.extractMemories` | `boolean` | `true` | Whether to extract durable memories to the daily memory file during compaction. |

---

## Cron

Cron job scheduler configuration.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `cron.enabled` | `boolean` | `true` | Whether the cron scheduler is active. |
| `cron.maxJobs` | `number` | `200` | Maximum number of cron jobs. |
| `cron.maxRunsPerJobHistory` | `number` | `200` | Maximum number of run history entries retained per job. |
| `cron.maxConcurrentRuns` | `number` | `4` | Maximum number of cron jobs executing concurrently. |

---

## Configuration Merging

User-provided configuration is a deep-partial type (`GsvConfigInput`). The `mergeConfig` function deep-merges overrides onto the default config:

- **Objects** are merged recursively.
- **Arrays** in overrides replace the base array entirely.
- **Primitives** (`string`, `number`, `boolean`) in overrides replace the base value.
- **`undefined`** values in overrides are ignored (base value preserved).
