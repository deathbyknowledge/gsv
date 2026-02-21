# Session Routing Reference

Sessions in GSV are keyed conversations between an agent and one or more peers. Session routing determines which Durable Object instance handles a given conversation by constructing a deterministic session key from the agent, channel, account, and peer identifiers.

## Session Key Format

All structured session keys begin with the `agent:` prefix. The full format depends on the peer kind and the configured `dmScope`.

### Main Session Key

```
agent:{agentId}:{mainKey}
```

The main session is the canonical session for an agent. It is used when `dmScope` is `main` (all DMs collapse to a single session) or when referenced directly by alias.

| Component | Description | Default |
|---|---|---|
| `agentId` | Normalized agent identifier | `main` |
| `mainKey` | Canonical key suffix for the main session | `main` |

Default main session key: `agent:main:main`

### DM Session Keys

DM (direct message) session keys vary by `dmScope`:

| dmScope | Key Format | Description |
|---|---|---|
| `main` | `agent:{agentId}:{mainKey}` | All DMs route to the agent's main session |
| `per-peer` | `agent:{agentId}:dm:{peerId}` | One session per peer, regardless of channel |
| `per-channel-peer` | `agent:{agentId}:{channel}:dm:{peerId}` | One session per channel+peer combination |
| `per-account-channel-peer` | `agent:{agentId}:{channel}:{accountId}:dm:{peerId}` | One session per account+channel+peer |

### Non-DM Session Keys

For non-DM peer kinds (e.g., groups):

```
agent:{agentId}:{channel}:{peerKind}:{peerId}
```

Non-DM keys are not affected by `dmScope`.

## Key Components

### `agentId`

| Property | Value |
|---|---|
| Default | `main` |
| Max length | 64 characters |
| Valid characters | `[a-z0-9][a-z0-9_-]*` (case-insensitive, stored lowercase) |
| Normalization | Lowercased. Invalid characters replaced with `-`. Leading/trailing dashes stripped. Empty or invalid input resolves to `main`. |

### `channel`

| Property | Value |
|---|---|
| Default | `unknown` |
| Normalization | Lowercased. Invalid characters (outside `[a-z0-9+\-_@.]`) replaced with `_`. |

Common channel values:

| Channel | Source |
|---|---|
| `cli` | CLI client connections |
| `whatsapp` | WhatsApp channel worker |
| `discord` | Discord channel worker |

### `accountId`

| Property | Value |
|---|---|
| Default | `default` |
| Max length | 64 characters |
| Valid characters | `[a-z0-9][a-z0-9_-]*` (case-insensitive, stored lowercase) |
| Normalization | Same rules as `agentId`. Empty or invalid input resolves to `default`. |

Used only in `per-account-channel-peer` scope to distinguish between multiple bot accounts on the same channel.

### `peerKind`

| Property | Value |
|---|---|
| Default | `dm` |
| Normalization | Lowercased. Invalid characters replaced with `_`. |

Identifies the type of conversation. The value `dm` activates DM-specific routing logic (dmScope). All other values use the non-DM key format.

### `peerId`

| Property | Value |
|---|---|
| Default | `unknown` |
| Normalization | Lowercased. Invalid characters replaced with `_`. |

Identifies the remote peer. For WhatsApp, this is the phone number JID (e.g., `31628552611@s.whatsapp.net`). For Discord, the user or channel ID.

### `mainKey`

| Property | Value |
|---|---|
| Default | `main` |
| Normalization | Lowercased. Empty input resolves to `main`. |
| Config path | `session.mainKey` |

The suffix used for the agent's main session. Configurable to allow renaming the main session without breaking existing non-main sessions.

## Identity Links

Identity links allow multiple channel-specific peer IDs to resolve to a single canonical peer identity for session routing. When a linked identity is found, it replaces the `peerId` in key construction.

Configuration path: `session.identityLinks`

```json
{
  "session": {
    "identityLinks": {
      "steve": ["+31628552611", "telegram:123456789", "whatsapp:+34675706329"]
    }
  }
}
```

Link entries support two formats:

| Format | Example | Matching |
|---|---|---|
| Plain (no prefix) | `+31628552611` | Matched against any channel after E.164 normalization |
| Channel-prefixed | `whatsapp:+34675706329` | Matched only when the channel name matches |

When a match is found, the canonical name (e.g., `steve`) is used as the `peerId`.

## dmScope Modes

The `dmScope` config field (`session.dmScope`) controls how DM conversations are mapped to sessions.

| Mode | Key Format | Use Case |
|---|---|---|
| `main` | `agent:{agentId}:{mainKey}` | Single shared session. All DMs from all channels and peers are handled in one session. |
| `per-peer` | `agent:{agentId}:dm:{peerId}` | One session per unique peer. The same person messaging from WhatsApp and Discord shares one session (when identity links are configured). |
| `per-channel-peer` | `agent:{agentId}:{channel}:dm:{peerId}` | One session per channel+peer. The same person on different channels gets separate sessions. |
| `per-account-channel-peer` | `agent:{agentId}:{channel}:{accountId}:dm:{peerId}` | Most granular. Separates sessions by bot account, useful when multiple bot accounts exist on the same channel. |

Default: `main`

## Canonicalization

`canonicalizeSessionKey()` normalizes any session key by parsing and rebuilding it through `buildAgentSessionKey`. This applies:

- dmScope collapsing (e.g., a `per-channel-peer` key collapses to `main` when dmScope is `main`)
- mainKey aliasing (both `main` and the configured mainKey resolve to the same key)
- Identifier normalization (lowercasing, invalid character replacement)

Simple aliases (strings not starting with `agent:`) that match the mainKey or `main` are resolved to the full main session key.

## Main Session Detection

A session key is considered the "main session" when its canonicalized form equals `agent:{agentId}:{mainKey}`. This check is used to:

- Control whether `MEMORY.md` is loaded (main sessions only)
- Report session type in the system prompt runtime section

## Session Key Parsing

`parseSessionKey()` decomposes a structured key into its parts:

```typescript
type ParsedSessionKey = {
  agentId: string;
  channel?: string;
  accountId?: string;
  peer: { kind: string; id: string };
};
```

The parser locates the `dm` marker in the colon-separated segments. Segments before `dm` are assigned to `channel` and `accountId` (positionally). Segments after `dm` are joined to form the peer ID (allowing colons in peer IDs).

Returns `null` for keys with fewer than 4 colon-separated parts or keys not starting with `agent:`.

## Auto-Reset Policies

Each session has an optional reset policy that controls automatic session clearing.

### Reset Policy Type

```typescript
type ResetPolicy = {
  mode: "manual" | "daily" | "idle";
  atHour?: number;
  idleMinutes?: number;
};
```

### Modes

| Mode | Behavior | Parameters |
|---|---|---|
| `manual` | No automatic reset. Sessions are reset only by explicit user action. | None |
| `daily` | Reset once per day when the first message arrives after the configured hour. | `atHour`: hour of day (0-23). Default: `4`. |
| `idle` | Reset when the session has been idle longer than the configured duration. | `idleMinutes`: minutes of inactivity. Default: `60`. |

### Daily Mode Logic

The reset boundary is computed as the most recent occurrence of `atHour:00:00.000` in server time. If the session's `updatedAt` timestamp is before this boundary, the next inbound message triggers a reset before processing.

### Idle Mode Logic

A reset triggers when `now - updatedAt > idleMinutes * 60000`.

### Default Policy

New sessions inherit the default reset policy from gateway config at `session.defaultResetPolicy`. The system default is:

```json
{
  "mode": "daily",
  "atHour": 4
}
```

### Reset Behavior

When an auto-reset triggers:

1. Current messages are archived to R2 (see R2 Storage Layout Reference).
2. Memories are extracted from the conversation and appended to the daily memory file dated to the conversation's last activity.
3. Session media is deleted from R2.
4. Messages are cleared from SQLite.
5. A new `sessionId` (UUID) is generated.
6. The old `sessionId` is appended to `previousSessionIds`.
7. Token counters are zeroed.
8. `lastResetAt` is set to the current time.
9. The triggering user message is added to the fresh session.
10. The agent loop continues with the new message.

## Session Lifecycle

### Creation

A session Durable Object is created on first message. The `sessionKey` is set from the routed key, and a `sessionId` (UUID v4) is generated. The session key is the Durable Object's identity and is stable across resets.

### Active Use

Messages are stored in SQLite within the DO. Each message triggers an agent loop: LLM call, optional tool calls, response broadcast. Messages arriving during an active run are queued and processed sequentially.

### Compaction

When the estimated context size approaches the model's context window, automatic compaction summarizes older messages, archives them to R2 as partial archives, extracts memories to the daily memory file, and replaces old messages with a synthetic summary.

### Reset

Resets can be manual (user-initiated) or automatic (policy-driven). Both follow the same archival and cleanup procedure. The session key remains stable; only the `sessionId` changes.

### Archival

On reset, the complete message history is serialized to JSONL, gzip-compressed, and stored in R2 at `agents/{agentId}/sessions/{sessionId}.jsonl.gz`. Partial archives from compaction use the suffix `-part{timestamp}`.
