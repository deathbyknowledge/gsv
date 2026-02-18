# WebSocket Protocol Reference

All communication between GSV clients, nodes, and the gateway uses JSON frames over WebSocket. The gateway endpoint is `GET /ws`.

---

## Frame Types

Every message is a JSON object with a `type` discriminator.

### Request Frame

```json
{
  "type": "req",
  "id": "<string>",
  "method": "<string>",
  "params": <object|undefined>
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"req"` | yes | Frame type discriminator. |
| `id` | `string` | yes | Unique request identifier (UUID). Used to correlate responses. |
| `method` | `string` | yes | RPC method name. |
| `params` | `unknown` | no | Method-specific parameters. |

### Response Frame

```json
{
  "type": "res",
  "id": "<string>",
  "ok": <boolean>,
  "payload": <object|undefined>,
  "error": <ErrorShape|undefined>
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"res"` | yes | Frame type discriminator. |
| `id` | `string` | yes | Matches the `id` of the originating request. |
| `ok` | `boolean` | yes | `true` for success, `false` for error. |
| `payload` | `unknown` | no | Present when `ok` is `true`. Method-specific result. |
| `error` | `ErrorShape` | no | Present when `ok` is `false`. |

### Event Frame

```json
{
  "type": "evt",
  "event": "<string>",
  "payload": <object|undefined>,
  "seq": <number|undefined>
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"evt"` | yes | Frame type discriminator. |
| `event` | `string` | yes | Event name. |
| `payload` | `unknown` | no | Event-specific payload. |
| `seq` | `number` | no | Sequence number for ordered events. |

### ErrorShape

```typescript
{
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | `number` | yes | Error code. |
| `message` | `string` | yes | Human-readable error message. |
| `details` | `unknown` | no | Additional error context. |
| `retryable` | `boolean` | no | Whether the client should retry. |

---

## Connection Lifecycle

1. Client opens a WebSocket to `GET /ws`.
2. Client sends a `connect` request as the first frame.
3. Gateway validates the connection and responds with a `ConnectResult`.
4. The connection is now established. The client may send RPC requests; the gateway may send events and requests.
5. The connection terminates when either side closes the WebSocket.

---

## RPC Methods

There are 46 registered RPC methods, organized by category below. Each entry documents the method name, direction, request params type, and response payload type.

Direction abbreviations:
- **C -> G**: client sends to gateway
- **N -> G**: node sends to gateway
- **G -> N**: gateway sends to node (dispatched as events)

### Connect

#### `connect`

**Direction:** C -> G, N -> G

Handshake method. Must be the first frame sent after WebSocket open.

**Params: `ConnectParams`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `minProtocol` | `number` | yes | Minimum protocol version supported. Currently `1`. |
| `maxProtocol` | `number` | yes | Maximum protocol version supported. Currently `1`. |
| `client` | `object` | yes | Client identity (see below). |
| `tools` | `ToolDefinition[]` | no | Tool definitions (node mode only). |
| `nodeRuntime` | `NodeRuntimeInfo` | no | Node runtime capabilities (node mode only). |
| `auth` | `{ token?: string }` | no | Authentication credentials. |

**`client` object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Client identifier. Nodes use `node-<hostname>`. Clients use `client-<uuid>`. |
| `version` | `string` | yes | CLI version. |
| `platform` | `string` | yes | OS name (e.g., `macos`, `linux`). |
| `mode` | `string` | yes | Connection mode: `"client"`, `"node"`, or `"channel"`. |
| `channel` | `ChannelId` | no | Channel identifier (channel mode only). |
| `accountId` | `string` | no | Account identifier (channel mode only). |

**Result: `ConnectResult`**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"hello-ok"` | Fixed response type. |
| `protocol` | `1` | Negotiated protocol version. |
| `server.version` | `string` | Gateway version. |
| `server.connectionId` | `string` | Unique connection ID assigned by the gateway. |
| `features.methods` | `string[]` | Available RPC methods. |
| `features.events` | `string[]` | Available event types. |

---

### Chat

#### `chat.send`

**Direction:** C -> G

Send a message to the agent for processing.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | `string` | yes | Target session key. |
| `message` | `string` | yes | Message text. May contain slash commands or directives. |
| `runId` | `string` | no | Client-generated run ID for correlation. |

**Result:** One of three variants:

*Started (normal agent turn):*

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"started"` | Agent turn has started. |
| `runId` | `string` | Run identifier. |
| `queued` | `boolean` | Whether the message was queued behind another run. |
| `directives.thinkLevel` | `string` | Thinking level directive, if parsed from message. |
| `directives.model` | `object` | Model override directive, if parsed from message. |

*Command (slash command handled synchronously):*

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"command"` | A slash command was handled. |
| `command` | `string` | The command that was executed. |
| `response` | `string` | Command output. |
| `error` | `string` | Error message, if command failed. |

*Directive-only (no agent turn needed):*

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"directive-only"` | Only directives were parsed; no message sent to agent. |
| `response` | `string` | Acknowledgement text. |
| `directives` | `object` | Parsed directives. |

---

### Configuration

#### `config.get`

**Direction:** C -> G

Get gateway configuration values.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | no | Dot-separated config path. If omitted, returns the full config object. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Echoed path, if provided. |
| `value` | `unknown` | Value at the specified path. |
| `config` | `GsvConfig` | Full config object, if no path specified. |

#### `config.set`

**Direction:** C -> G

Set a gateway configuration value.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | Dot-separated config path. |
| `value` | `unknown` | yes | Value to set. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Success indicator. |
| `path` | `string` | Echoed path. |

---

### Tools

#### `tools.list`

**Direction:** C -> G, N -> G

List all tools registered by connected nodes.

**Params:** none

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `tools` | `ToolDefinition[]` | Array of tool definitions. |

**`ToolDefinition`:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Tool name (e.g., `macbook:Bash`). |
| `description` | `string` | Tool description. |
| `inputSchema` | `object` | JSON Schema for tool input. |

#### `tool.invoke`

**Direction:** C -> G

Invoke a tool by name. The gateway dispatches the call to the appropriate node. This is a deferred method: the gateway may respond asynchronously after the node returns a result.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tool` | `string` | yes | Tool name. |
| `args` | `object` | no | Tool arguments. |

**Result:** The tool execution result (varies by tool).

#### `tool.result`

**Direction:** N -> G

Return the result of a tool invocation back to the gateway.

**Params: `ToolResultParams`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `callId` | `string` | yes | Call ID from the `tool.invoke` event. |
| `result` | `unknown` | no | Tool result value (on success). |
| `error` | `string` | no | Error message (on failure). |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Acknowledgement. |
| `dropped` | `boolean` | `true` if the result was dropped (e.g., session no longer waiting). |

#### `tool.request`

**Direction:** C -> G

Request a tool invocation in the context of a session (used by the agent loop).

**Params: `ToolRequestParams`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `callId` | `string` | yes | Unique call identifier. |
| `tool` | `string` | yes | Tool name. |
| `args` | `object` | yes | Tool arguments. |
| `sessionKey` | `string` | yes | Session context for the tool call. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"sent"` | Confirmation that the request was dispatched. |

---

### Node

#### `node.probe.result`

**Direction:** N -> G

Return the result of a node probe (binary availability check).

**Params: `NodeProbeResultParams`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `probeId` | `string` | yes | Probe ID from the `node.probe` event. |
| `ok` | `boolean` | yes | Whether the probe succeeded. |
| `bins` | `Record<string, boolean>` | no | Map of binary name to availability. |
| `error` | `string` | no | Error message if probe failed. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Acknowledgement. |
| `dropped` | `boolean` | `true` if the probe result was dropped. |

#### `node.exec.event`

**Direction:** N -> G

Report a node execution event (process started, finished, failed, or timed out).

**Params: `NodeExecEventParams`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `eventId` | `string` | yes | Unique event identifier. |
| `sessionId` | `string` | yes | Session that triggered the execution. |
| `event` | `string` | yes | Event type: `"started"`, `"finished"`, `"failed"`, or `"timed_out"`. |
| `callId` | `string` | no | Tool call ID. |
| `exitCode` | `number \| null` | no | Process exit code. |
| `signal` | `string` | no | Signal that terminated the process. |
| `outputTail` | `string` | no | Last portion of process output. |
| `startedAt` | `number` | no | Start timestamp (epoch ms). |
| `endedAt` | `number` | no | End timestamp (epoch ms). |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Acknowledgement. |
| `dropped` | `boolean` | `true` if the event was dropped. |

---

### Logs

#### `logs.get`

**Direction:** C -> G

Request node logs. The gateway dispatches a `logs.get` event to the target node. This is a deferred method.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nodeId` | `string` | no | Target node ID. If omitted, uses the execution host. |
| `lines` | `number` | no | Number of log lines to retrieve (default: 100, max: 5000). |

**Result: `LogsGetResult`**

| Field | Type | Description |
|-------|------|-------------|
| `nodeId` | `string` | Node that returned the logs. |
| `lines` | `string[]` | Log lines. |
| `count` | `number` | Number of lines returned. |
| `truncated` | `boolean` | Whether the full log was truncated. |

#### `logs.result`

**Direction:** N -> G

Return log lines in response to a `logs.get` event.

**Params: `LogsResultParams`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `callId` | `string` | yes | Call ID from the `logs.get` event. |
| `lines` | `string[]` | no | Log lines. |
| `truncated` | `boolean` | no | Whether the output was truncated. |
| `error` | `string` | no | Error message if log retrieval failed. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Acknowledgement. |
| `dropped` | `boolean` | `true` if the result was dropped. |

---

### Session

#### `sessions.list`

**Direction:** C -> G

List all known sessions.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `offset` | `number` | no | Pagination offset. |
| `limit` | `number` | no | Maximum sessions to return. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `sessions` | `SessionRegistryEntry[]` | Session list. |
| `count` | `number` | Total session count. |

**`SessionRegistryEntry`:**

| Field | Type | Description |
|-------|------|-------------|
| `sessionKey` | `string` | Session key. |
| `createdAt` | `number` | Creation timestamp (epoch ms). |
| `lastActiveAt` | `number` | Last activity timestamp (epoch ms). |
| `label` | `string` | Optional session label. |

#### `session.get`

**Direction:** C -> G

Get detailed session information.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | `string` | yes | Session key. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Current session ID. |
| `sessionKey` | `string` | Session key. |
| `createdAt` | `number` | Creation timestamp (epoch ms). |
| `updatedAt` | `number` | Last update timestamp (epoch ms). |
| `messageCount` | `number` | Number of messages in the session. |
| `tokens` | `TokenUsage` | Token usage breakdown. |
| `settings` | `SessionSettings` | Session settings. |
| `resetPolicy` | `ResetPolicy` | Automatic reset policy. |
| `lastResetAt` | `number` | Timestamp of last reset (epoch ms). |
| `previousSessionIds` | `string[]` | Previous session IDs from resets. |
| `label` | `string` | Session label. |

**`TokenUsage`:**

| Field | Type | Description |
|-------|------|-------------|
| `input` | `number` | Input tokens consumed. |
| `output` | `number` | Output tokens consumed. |
| `total` | `number` | Total tokens consumed. |

**`SessionSettings`:**

| Field | Type | Description |
|-------|------|-------------|
| `model` | `{ provider: string; id: string }` | Model override. |
| `thinkingLevel` | `string` | One of: `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`. |
| `systemPrompt` | `string` | System prompt override. |
| `maxTokens` | `number` | Maximum output tokens. |

**`ResetPolicy`:**

| Field | Type | Description |
|-------|------|-------------|
| `mode` | `string` | `"manual"`, `"daily"`, or `"idle"`. |
| `atHour` | `number` | Hour for daily reset (0-23). Only for `daily` mode. |
| `idleMinutes` | `number` | Minutes idle before reset. Only for `idle` mode. |

#### `session.stats`

**Direction:** C -> G

Get session statistics.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | `string` | yes | Session key. |

**Result: `SessionStats`**

| Field | Type | Description |
|-------|------|-------------|
| `sessionKey` | `string` | Session key. |
| `sessionId` | `string` | Current session ID. |
| `messageCount` | `number` | Message count. |
| `tokens` | `TokenUsage` | Token usage. |
| `createdAt` | `number` | Creation timestamp (epoch ms). |
| `updatedAt` | `number` | Last update timestamp (epoch ms). |
| `uptime` | `number` | Session uptime in milliseconds. |
| `isProcessing` | `boolean` | Whether a run is currently active. |
| `queueSize` | `number` | Number of queued messages. |

#### `session.reset`

**Direction:** C -> G

Reset a session: clear messages, archive to R2, create a new session ID.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | `string` | yes | Session key. |

**Result: `ResetResult`**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `boolean` | Success indicator. |
| `sessionKey` | `string` | Session key. |
| `oldSessionId` | `string` | Previous session ID. |
| `newSessionId` | `string` | New session ID. |
| `archivedMessages` | `number` | Number of messages archived. |
| `archivedTo` | `string` | R2 path of the archive. |
| `tokensCleared` | `TokenUsage` | Token counts that were cleared. |
| `mediaDeleted` | `number` | Number of media files deleted. |

#### `session.patch`

**Direction:** C -> G

Update session settings, label, or reset policy.

**Params: `SessionPatchParams & { sessionKey: string }`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | `string` | yes | Session key. |
| `settings` | `Partial<SessionSettings>` | no | Settings to merge. |
| `label` | `string` | no | New label. |
| `resetPolicy` | `Partial<ResetPolicy>` | no | Reset policy fields to merge. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `boolean` | Success indicator. |

#### `session.compact`

**Direction:** C -> G

Trim a session to the last N messages. Removed messages are archived.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | `string` | yes | Session key. |
| `keepMessages` | `number` | no | Number of messages to keep (default: 20). |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `boolean` | Success indicator. |
| `trimmedMessages` | `number` | Messages removed. |
| `keptMessages` | `number` | Messages remaining. |
| `archivedTo` | `string` | R2 archive path. |

#### `session.history`

**Direction:** C -> G

Get session reset history.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | `string` | yes | Session key. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `sessionKey` | `string` | Session key. |
| `currentSessionId` | `string` | Current session ID. |
| `previousSessionIds` | `string[]` | List of previous session IDs. |

#### `session.preview`

**Direction:** C -> G

Preview session messages.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sessionKey` | `string` | yes | Session key. |
| `limit` | `number` | no | Maximum messages to return. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `sessionKey` | `string` | Session key. |
| `sessionId` | `string` | Current session ID. |
| `messageCount` | `number` | Total message count. |
| `messages` | `unknown[]` | Message objects (role, content, etc.). |

---

### Channel

#### `channels.list`

**Direction:** C -> G

List all connected channel accounts.

**Params:** none

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `channels` | `ChannelRegistryEntry[]` | Connected channel accounts. |
| `count` | `number` | Total count. |

**`ChannelRegistryEntry`:**

| Field | Type | Description |
|-------|------|-------------|
| `channel` | `ChannelId` | Channel identifier (`"whatsapp"`, `"discord"`, etc.). |
| `accountId` | `string` | Account identifier. |
| `connectedAt` | `number` | Connection timestamp (epoch ms). |
| `lastMessageAt` | `number` | Last message timestamp (epoch ms). |

#### `channel.inbound`

**Direction:** Channel -> G

Deliver an inbound message from a channel to the gateway.

**Params: `ChannelInboundParams`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | `ChannelId` | yes | Channel identifier. |
| `accountId` | `string` | yes | Account identifier. |
| `peer` | `PeerInfo` | yes | Peer (chat) information. |
| `sender` | `SenderInfo` | no | Sender information. |
| `message` | `object` | yes | Message payload (see below). |
| `wasMentioned` | `boolean` | no | Whether the bot was mentioned. |
| `mentionedIds` | `string[]` | no | IDs mentioned in the message. |

**`PeerInfo`:**

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `string` | Chat type: `"dm"`, `"group"`, `"channel"`, or `"thread"`. |
| `id` | `string` | Chat/peer identifier. |
| `name` | `string` | Display name. |
| `handle` | `string` | Username/handle. |

**`SenderInfo`:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Sender identifier. |
| `name` | `string` | Display name. |
| `handle` | `string` | Username/handle. |

**`message` object:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Message identifier. |
| `text` | `string` | Message text. |
| `timestamp` | `number` | Message timestamp (epoch ms). |
| `replyToId` | `string` | ID of the message being replied to. |
| `replyToText` | `string` | Text of the message being replied to. |
| `media` | `MediaAttachment[]` | Media attachments. |
| `location` | `{ lat, lon, name? }` | Location attachment. |

**`MediaAttachment`:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | `"image"`, `"audio"`, `"video"`, or `"document"`. |
| `mimeType` | `string` | MIME type. |
| `data` | `string` | Base64-encoded content. |
| `r2Key` | `string` | R2 storage key. |
| `url` | `string` | URL to the media. |
| `filename` | `string` | Original filename. |
| `size` | `number` | File size in bytes. |
| `duration` | `number` | Duration in seconds (audio/video). |
| `transcription` | `string` | Transcribed text (audio). |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | Processing status. |
| `sessionKey` | `string` | Session key the message was routed to. |

#### `channel.start`

**Direction:** C -> G

Start a channel connection.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | `string` | yes | Channel name (e.g., `"discord"`). |
| `accountId` | `string` | no | Account identifier. |
| `config` | `object` | no | Channel-specific configuration. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Success. |
| `channel` | `ChannelId` | Channel identifier. |
| `accountId` | `string` | Account identifier. |

#### `channel.stop`

**Direction:** C -> G

Stop a channel connection.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | `string` | yes | Channel name. |
| `accountId` | `string` | no | Account identifier. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Success. |
| `channel` | `ChannelId` | Channel identifier. |
| `accountId` | `string` | Account identifier. |

#### `channel.status`

**Direction:** C -> G

Get status of a channel's accounts.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | `string` | yes | Channel name. |
| `accountId` | `string` | no | Account identifier. If omitted, returns all accounts. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `channel` | `ChannelId` | Channel identifier. |
| `accounts` | `ChannelAccountStatus[]` | Account status entries. |

**`ChannelAccountStatus`** fields include `accountId`, `connected`, `authenticated`, `error`, `extra`, and `lastActivity`.

#### `channel.login`

**Direction:** C -> G

Initiate channel login (e.g., WhatsApp QR code flow).

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | `string` | yes | Channel name. |
| `accountId` | `string` | no | Account identifier. |
| `force` | `boolean` | no | Force re-login even if already authenticated. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Success. |
| `channel` | `ChannelId` | Channel identifier. |
| `accountId` | `string` | Account identifier. |
| `qrDataUrl` | `string` | QR code data for scanning (WhatsApp). |
| `message` | `string` | Status message. |

#### `channel.logout`

**Direction:** C -> G

Logout from a channel and clear stored credentials.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | `string` | yes | Channel name. |
| `accountId` | `string` | no | Account identifier. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Success. |
| `channel` | `ChannelId` | Channel identifier. |
| `accountId` | `string` | Account identifier. |

---

### Heartbeat

#### `heartbeat.status`

**Direction:** C -> G

Get heartbeat scheduler status for all agents.

**Params:** none

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `agents` | `Record<string, object>` | Map of agent ID to heartbeat state (includes `nextHeartbeatAt`, `lastHeartbeatAt`, `lastActive`). |

#### `heartbeat.start`

**Direction:** C -> G

Start the heartbeat scheduler.

**Params:** none

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `message` | `string` | Status message. |
| `agents` | `Record<string, object>` | Agent heartbeat states. |

#### `heartbeat.trigger`

**Direction:** C -> G

Manually trigger a heartbeat.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | `string` | no | Agent ID (default: `"main"`). |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `boolean` | Success indicator. |
| `message` | `string` | Status message. |
| `skipped` | `boolean` | Whether the heartbeat was skipped. |
| `skipReason` | `string` | Reason for skipping. |

---

### Cron

#### `cron.status`

**Direction:** C -> G

Get cron scheduler status.

**Params:** none

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | `boolean` | Whether the cron scheduler is enabled. |
| `count` | `number` | Total number of cron jobs. |
| `dueCount` | `number` | Number of jobs due to run. |
| `runningCount` | `number` | Number of currently running jobs. |
| `nextRunAtMs` | `number` | Next scheduled run (epoch ms). |
| `maxJobs` | `number` | Maximum allowed jobs. |
| `maxConcurrentRuns` | `number` | Maximum concurrent runs. |

#### `cron.list`

**Direction:** C -> G

List cron jobs.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | `string` | no | Filter by agent ID. |
| `includeDisabled` | `boolean` | no | Include disabled jobs. |
| `limit` | `number` | no | Maximum jobs to return. |
| `offset` | `number` | no | Pagination offset. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `jobs` | `CronJob[]` | List of cron jobs. |
| `count` | `number` | Total count. |

**`CronJob`:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Job identifier. |
| `agentId` | `string` | Agent that owns this job. |
| `name` | `string` | Job name. |
| `description` | `string` | Job description. |
| `enabled` | `boolean` | Whether the job is enabled. |
| `deleteAfterRun` | `boolean` | Whether to delete the job after it runs. |
| `createdAtMs` | `number` | Creation timestamp (epoch ms). |
| `updatedAtMs` | `number` | Last update timestamp (epoch ms). |
| `schedule` | `CronSchedule` | Schedule configuration. |
| `spec` | `CronMode` | Job execution specification. |
| `state` | `CronJobState` | Current runtime state. |

**`CronSchedule`** variants:

| Kind | Fields | Description |
|------|--------|-------------|
| `"at"` | `atMs: number` | Run once at a specific epoch timestamp. |
| `"every"` | `everyMs: number`, `anchorMs?: number` | Run at a fixed interval. |
| `"cron"` | `expr: string`, `tz?: string` | Standard cron expression with optional timezone. |

**`CronMode`** variants:

| Mode | Fields | Description |
|------|--------|-------------|
| `"systemEvent"` | `text: string` | Inject a user message into the agent's main session. |
| `"task"` | `message: string`, `model?`, `thinking?`, `timeoutSeconds?`, `deliver?`, `channel?`, `to?`, `bestEffortDeliver?` | Run in an isolated cron session with optional delivery control. |

**`CronJobState`:**

| Field | Type | Description |
|-------|------|-------------|
| `nextRunAtMs` | `number` | Next scheduled run (epoch ms). |
| `runningAtMs` | `number` | Currently running since (epoch ms). |
| `lastRunAtMs` | `number` | Last run timestamp (epoch ms). |
| `lastStatus` | `string` | `"ok"`, `"error"`, or `"skipped"`. |
| `lastError` | `string` | Error from last run. |
| `lastDurationMs` | `number` | Duration of last run (ms). |

#### `cron.add`

**Direction:** C -> G

Create a new cron job.

**Params: `CronJobCreate`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | `string` | no | Agent ID (default: `"main"`). |
| `name` | `string` | yes | Job name. |
| `description` | `string` | no | Job description. |
| `enabled` | `boolean` | no | Whether enabled (default: true). |
| `deleteAfterRun` | `boolean` | no | Delete after execution. |
| `schedule` | `CronSchedule` | yes | Schedule configuration. |
| `spec` | `CronMode` | yes | Execution specification. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Success. |
| `job` | `CronJob` | Created job. |

#### `cron.update`

**Direction:** C -> G

Update an existing cron job.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Job ID. |
| `patch` | `CronJobPatch` | yes | Fields to update. |

**`CronJobPatch`:** Same fields as `CronJobCreate` but all optional. The `spec` field uses `CronModePatch` (all fields except `mode` are optional).

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Success. |
| `job` | `CronJob` | Updated job. |

#### `cron.remove`

**Direction:** C -> G

Remove a cron job.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Job ID. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Success. |
| `removed` | `boolean` | Whether the job existed and was removed. |

#### `cron.run`

**Direction:** C -> G

Manually trigger cron job execution.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | no | Specific job ID to run. If omitted, runs due jobs. |
| `mode` | `string` | no | `"due"` (default) or `"force"`. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Success. |
| `ran` | `number` | Number of jobs executed. |
| `results` | `CronRunResult[]` | Per-job results. |

**`CronRunResult`:**

| Field | Type | Description |
|-------|------|-------------|
| `jobId` | `string` | Job ID. |
| `status` | `string` | `"ok"`, `"error"`, or `"skipped"`. |
| `error` | `string` | Error message. |
| `summary` | `string` | Execution summary. |
| `durationMs` | `number` | Duration in milliseconds. |
| `nextRunAtMs` | `number` | Next scheduled run (epoch ms). |

#### `cron.runs`

**Direction:** C -> G

List cron run history.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `jobId` | `string` | no | Filter by job ID. |
| `limit` | `number` | no | Maximum runs to return. |
| `offset` | `number` | no | Pagination offset. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `runs` | `CronRun[]` | Run history entries. |
| `count` | `number` | Total count. |

**`CronRun`:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Run ID. |
| `jobId` | `string` | Job ID. |
| `ts` | `number` | Run timestamp (epoch ms). |
| `status` | `string` | `"ok"`, `"error"`, or `"skipped"`. |
| `error` | `string` | Error message. |
| `summary` | `string` | Execution summary. |
| `durationMs` | `number` | Duration in milliseconds. |
| `nextRunAtMs` | `number` | Next run (epoch ms). |

---

### Pairing

#### `pair.list`

**Direction:** C -> G

List pending pairing requests from unknown senders.

**Params:** none

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `pairs` | `Record<string, PendingPair>` | Map of pair key to pending pair details. |

**`PendingPair`** fields include `senderId`, `senderName`, `channel`, `firstMessage`, and `requestedAt`.

#### `pair.approve`

**Direction:** C -> G

Approve a pairing request.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | `string` | yes | Channel name. |
| `senderId` | `string` | yes | Sender ID. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `approved` | `true` | Confirmation. |
| `senderId` | `string` | Approved sender ID. |
| `senderName` | `string` | Sender display name. |

#### `pair.reject`

**Direction:** C -> G

Reject a pairing request.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | `string` | yes | Channel name. |
| `senderId` | `string` | yes | Sender ID. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `rejected` | `true` | Confirmation. |
| `senderId` | `string` | Rejected sender ID. |

---

### Skills

#### `skills.status`

**Direction:** C -> G

Get skill eligibility status.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | `string` | no | Agent ID (default: `"main"`). |

**Result: `SkillsStatusResult`**

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | `string` | Agent ID. |
| `refreshedAt` | `number` | Timestamp of last refresh (epoch ms). |
| `requiredBins` | `string[]` | Binaries required by any skill. |
| `nodes` | `SkillNodeStatus[]` | Connected node statuses. |
| `skills` | `SkillStatusEntry[]` | Skill eligibility entries. |

**`SkillNodeStatus`:**

| Field | Type | Description |
|-------|------|-------------|
| `nodeId` | `string` | Node identifier. |
| `hostRole` | `string` | `"execution"` or `"specialized"`. |
| `hostCapabilities` | `string[]` | Capability IDs. |
| `hostOs` | `string` | Operating system. |
| `hostEnv` | `string[]` | Environment variable names. |
| `hostBins` | `string[]` | Available binaries. |
| `hostBinStatusUpdatedAt` | `number` | Last bin probe timestamp (epoch ms). |
| `canProbeBins` | `boolean` | Whether the node supports bin probing. |

**`SkillStatusEntry`:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Skill name. |
| `description` | `string` | Skill description. |
| `location` | `string` | Source location (agent-level or global). |
| `always` | `boolean` | Whether the skill is always active. |
| `eligible` | `boolean` | Whether all requirements are met. |
| `eligibleHosts` | `string[]` | Node IDs that satisfy requirements. |
| `reasons` | `string[]` | Reasons for ineligibility. |
| `requirements` | `SkillRequirementSnapshot` | Requirement details. |

#### `skills.update`

**Direction:** C -> G

Re-probe nodes and refresh skill eligibility.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | `string` | no | Agent ID (default: `"main"`). |
| `force` | `boolean` | no | Force re-probing even when cache is fresh. |
| `timeoutMs` | `number` | no | Probe timeout in milliseconds. |

**Result: `SkillsUpdateResult`**

Extends `SkillsStatusResult` with:

| Field | Type | Description |
|-------|------|-------------|
| `updatedNodeCount` | `number` | Number of nodes that were probed. |
| `skippedNodeIds` | `string[]` | Node IDs skipped (fresh cache). |
| `errors` | `string[]` | Probe errors. |

---

### Workspace

#### `workspace.list`

**Direction:** C -> G

List files and directories in the agent workspace (R2).

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | no | Directory path within the workspace. |
| `agentId` | `string` | no | Agent ID. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Listed path. |
| `files` | `string[]` | File names. |
| `directories` | `string[]` | Directory names. |

#### `workspace.read`

**Direction:** C -> G

Read a file from the agent workspace.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | File path within the workspace. |
| `agentId` | `string` | no | Agent ID. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | File path. |
| `content` | `string` | File content. |
| `size` | `number` | File size in bytes. |
| `lastModified` | `string` | Last modified timestamp. |

#### `workspace.write`

**Direction:** C -> G

Write a file to the agent workspace.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | File path within the workspace. |
| `content` | `string` | yes | File content. |
| `agentId` | `string` | no | Agent ID. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | File path. |
| `size` | `number` | Written size in bytes. |
| `written` | `true` | Confirmation. |

#### `workspace.delete`

**Direction:** C -> G

Delete a file from the agent workspace.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | File path within the workspace. |
| `agentId` | `string` | no | Agent ID. |

**Result:**

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | File path. |
| `deleted` | `true` | Confirmation. |

---

## Events

Events are sent from the gateway to connected clients/nodes as `evt` frames. The node does not receive `chat` events; the client does not receive `tool.invoke` or `node.probe` events.

### `chat`

Emitted to clients during an agent turn.

**Payload: `ChatEventPayload`**

| Field | Type | Description |
|-------|------|-------------|
| `runId` | `string \| null` | Run identifier. |
| `sessionKey` | `string` | Session key for filtering. |
| `state` | `string` | Event state: `"partial"`, `"delta"`, `"final"`, or `"error"`. |
| `message` | `unknown` | Full message object (on `"final"` state). |
| `text` | `string` | Incremental text content (on `"delta"` / `"partial"` state). |
| `error` | `string` | Error message (on `"error"` state). |

### `tool.invoke`

Emitted to the appropriate node when the agent needs to call a tool.

**Payload: `ToolInvokePayload`**

| Field | Type | Description |
|-------|------|-------------|
| `callId` | `string` | Unique call identifier. The node must return this in `tool.result`. |
| `tool` | `string` | Tool name. |
| `args` | `object` | Tool arguments. |

### `logs.get`

Emitted to a node to request log lines.

**Payload: `LogsGetEventPayload`**

| Field | Type | Description |
|-------|------|-------------|
| `callId` | `string` | Call identifier. The node must return this in `logs.result`. |
| `lines` | `number` | Requested number of lines. |

### `node.probe`

Emitted to a node to check binary availability.

**Payload: `NodeProbePayload`**

| Field | Type | Description |
|-------|------|-------------|
| `probeId` | `string` | Probe identifier. The node must return this in `node.probe.result`. |
| `kind` | `string` | Probe kind. Currently only `"bins"`. |
| `bins` | `string[]` | Binary names to check. |
| `timeoutMs` | `number` | Probe timeout in milliseconds. |

---

## Node Runtime Info

Provided by nodes during the `connect` handshake.

**`NodeRuntimeInfo`:**

| Field | Type | Description |
|-------|------|-------------|
| `hostRole` | `string` | `"execution"` or `"specialized"`. |
| `hostCapabilities` | `string[]` | Capability IDs: `"filesystem.list"`, `"filesystem.read"`, `"filesystem.write"`, `"filesystem.edit"`, `"text.search"`, `"shell.exec"`. |
| `toolCapabilities` | `Record<string, string[]>` | Map of tool name to its capability IDs. |
| `hostOs` | `string` | Operating system (e.g., `"macos"`, `"linux"`). |
| `hostEnv` | `string[]` | Environment variable names present on the host. |
| `hostBinStatus` | `Record<string, boolean>` | Map of binary name to availability. |
| `hostBinStatusUpdatedAt` | `number` | Timestamp of last bin probe (epoch ms). |
