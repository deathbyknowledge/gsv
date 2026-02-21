# Native Tools Reference (gsv__*)

Native tools are built into the Gateway and available to agents without a connected node. All native tool names are prefixed with `gsv__`. Tool names are case-sensitive.

Native tools are defined in `gateway/src/agents/tools/`. The constant prefix is `"gsv__"` (defined in `gateway/src/agents/tools/constants.ts`).

All native tools return a result object with the shape:

```typescript
{ ok: boolean; result?: unknown; error?: string }
```

---

## Workspace Tools

Workspace tools operate on the agent's R2 workspace at `agents/{agentId}/`. Paths are relative to the workspace root unless otherwise noted. Path traversal (`..`) is rejected. Virtual `skills/` paths resolve agent-local overrides first, then fall back to global skills.

### gsv__ReadFile

Read a file or list a directory in the agent's workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | No | Path relative to workspace root. Omit or use `"/"` to list the root. Examples: `"SOUL.md"`, `"memory/"`, `"skills/summarize/SKILL.md"`. |

**File output:** `{ path, content: string, size: number, lastModified?: string }`

For `skills/*` paths, the output additionally includes:
- `resolvedPath`: The actual R2 key that was read.
- `resolvedSource`: `"agent"` or `"global"`, indicating which copy was found.

**Directory output:** `{ path, files: string[], directories: string[] }`

**Side effects:** None. Read-only.

**Behavior:** If path is omitted, lists the workspace root. If path points to a file, returns its content. If path points to a directory (or a file is not found at that path but objects exist under it as a prefix), returns a directory listing. For `skills/` paths, results are merged from agent-level and global locations, with agent files taking precedence for deduplication.

---

### gsv__WriteFile

Write or create a file in the agent's workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | File path relative to workspace root. |
| `content` | `string` | Yes | Content to write. |

**Output:** `{ path, size: number, written: true }`

**Side effects:** Creates or overwrites the file in R2. Parent directories are created implicitly (R2 has no directory concept). Sets `Content-Type` based on file extension: `.md` → `text/markdown`, `.json` → `application/json`, `.yaml`/`.yml` → `text/yaml`, all others → `text/plain`.

**Behavior:** Writes to `skills/*` paths always create or update agent-local overrides under `agents/{agentId}/skills/*`.

---

### gsv__EditFile

Edit a file by replacing exact text matches.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | File path relative to workspace root. |
| `oldString` | `string` | Yes | Exact text to find. Must not be empty. |
| `newString` | `string` | Yes | Replacement text. |
| `replaceAll` | `boolean` | No | Replace all occurrences. Default `false` (requires `oldString` to match exactly once). |

**Output:** `{ path, replacements: number, edited: true, resolvedSource?: string, resolvedPath?: string }`

**Side effects:** Reads the file, performs the replacement, and writes the result back. For `skills/*` paths, reads from agent-local or global (with agent-local priority), but always writes the result to the agent-local path.

**Error conditions:**
- `oldString` not found → error.
- `oldString` found multiple times and `replaceAll` is not `true` → error with match count.

---

### gsv__DeleteFile

Delete a file from the agent's workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | File path relative to workspace root. |

**Output:** `{ path, deleted: true }`

**Side effects:** Permanently deletes the R2 object. Checks for existence first; returns an error if the file is not found.

---

## Gateway Tools

Tools for inspecting Gateway state and connected node information.

### gsv__ConfigGet

Inspect the Gateway configuration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | No | Dotted path to a specific config value (e.g. `"session.dmScope"`, `"channels.whatsapp.allowFrom"`). When omitted, returns the full config (with sensitive values masked). |

**Output (with path):** `{ path, value }`

**Output (without path):** `{ config: <masked config object> }`

**Side effects:** None. Read-only.

**Behavior:** Requires Gateway context. Returns an error if the Gateway stub is unavailable.

---

### gsv__LogsGet

Fetch recent log lines from a connected node.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `nodeId` | `string` | No | Node ID to fetch logs from. Required when multiple nodes are connected. Auto-selects when exactly one node is connected. |
| `lines` | `number` | No | Number of lines to return. Default 100, maximum 5000. |

**Output:** Node log payload (structure determined by Gateway).

**Side effects:** None. Read-only.

**Behavior:** Requires Gateway context. Returns an error if the Gateway stub is unavailable.

---

## Cron Tools

### gsv__Cron

Manage scheduled cron jobs. This is a single tool with an `action` discriminator.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `string` | Yes | Action to execute. One of: `"status"`, `"list"`, `"add"`, `"update"`, `"remove"`, `"run"`, `"runs"`. |
| `id` | `string` | No | Job ID. Required for `"update"`, `"remove"`, and `"run"` with `mode: "force"`. |
| `mode` | `"due" \| "force"` | No | Run mode for `action: "run"`. `"due"` runs only due jobs. `"force"` runs a specific job immediately. |
| `agentId` | `string` | No | Agent filter for `"list"` and `"status"`, or owner agent for `"add"`. |
| `includeDisabled` | `boolean` | No | Whether disabled jobs are included for `action: "list"`. |
| `limit` | `number` | No | Pagination limit for `"list"` and `"runs"`. |
| `offset` | `number` | No | Pagination offset for `"list"` and `"runs"`. |
| `job` | `object` | No | Job create payload for `action: "add"`. See Job Object below. |
| `patch` | `object` | No | Job patch payload for `action: "update"`. Same fields as `job`, all optional. |
| `jobId` | `string` | No | Job ID filter for `action: "runs"`. |

**Side effects:** `"add"` creates a new job. `"update"` modifies an existing job. `"remove"` deletes a job. `"run"` triggers job execution.

**Behavior:** Requires Gateway context. Delegates to `gateway.executeCronTool()`.

#### Job Object

Used as the `job` parameter for `action: "add"`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Human-readable job name. |
| `schedule` | `object` | Yes | Schedule definition. See Schedule Object. |
| `spec` | `object` | Yes | Job spec. See Spec Object. |
| `agentId` | `string` | No | Agent that owns the job. Default `"main"`. |
| `description` | `string` | No | Human-readable description. |
| `enabled` | `boolean` | No | Whether the job is active. Default `true`. |
| `deleteAfterRun` | `boolean` | No | Delete the job after a successful one-shot run. |

#### Schedule Object

The `schedule` object requires a `kind` discriminator.

| Kind | Fields | Description |
|------|--------|-------------|
| `"at"` | `at: string` | One-shot schedule. `at` supports ISO datetime strings, relative strings (e.g. `"in 2 hours"`), and `"today"`/`"tomorrow"` forms. Interpreted in user timezone when no timezone is specified. |
| `"at"` | `in: string` | Relative one-shot shorthand (e.g. `"in 30 minutes"`). |
| `"every"` | `everyMinutes?: number`, `everyHours?: number`, `everyDays?: number`, `anchor?: string` | Interval schedule. Specify one duration field. `anchor` is an optional datetime string; if omitted, the interval starts from now. |
| `"cron"` | `expr: string`, `tz?: string` | Cron expression schedule. `expr` is a 5-field cron expression. `tz` is an IANA timezone (defaults to user timezone). |

#### Spec Object

The `spec` object requires a `mode` discriminator.

| Mode | Fields | Description |
|------|--------|-------------|
| `"systemEvent"` | `text: string` | Injects text into the agent's main session. The agent processes it in the existing conversation context. Response is delivered to the last active channel. |
| `"task"` | `message: string`, `deliver?: boolean`, `channel?: string`, `to?: string`, `model?: string`, `thinking?: string`, `timeoutSeconds?: number`, `bestEffortDeliver?: boolean` | Runs a full agent turn in an isolated session (clean conversation, no carry-over). Supports explicit delivery control. |

---

## Message Tools

### gsv__Message

Send a message to a channel or user.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | Yes | Message text to send. |
| `channel` | `string` | No | Channel to send to (e.g. `"whatsapp"`, `"discord"`). Defaults to the user's current channel. |
| `to` | `string` | No | Peer ID to send to (phone number, user ID, channel ID). Defaults to the user's current peer. |
| `peerKind` | `"dm" \| "group" \| "channel" \| "thread"` | No | Type of conversation. Defaults to the current peer kind, or `"dm"` if unknown. |
| `accountId` | `string` | No | Account ID for multi-account channels. Defaults to the current account. |
| `replyToId` | `string` | No | Message ID to reply to. |

**Output:** Determined by Gateway `executeMessageTool()`.

**Side effects:** Sends a message to an external channel via service binding RPC.

**Behavior:** When called without `channel` or `to`, sends to the last active channel and peer for the current session. Requires Gateway context.

---

## Session Tools

### gsv__SessionsList

List active sessions with metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | `number` | No | Maximum number of sessions to return. Default 20, maximum 100. |
| `offset` | `number` | No | Pagination offset. Default 0. |
| `messageLimit` | `number` | No | Number of recent messages to include per session (0–20). Default 0 (none). |

**Output:** Determined by Gateway `executeSessionsListTool()`. Contains session keys, labels, last activity times, and optionally recent messages.

**Side effects:** None. Read-only.

**Behavior:** Requires Gateway context.

---

### gsv__SessionSend

Send a message into another session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionKey` | `string` | Yes | Target session key (e.g. `"main"`, `"agent:helper:main"`). |
| `message` | `string` | Yes | Message text to send. |
| `waitSeconds` | `number` | No | Seconds to wait for a reply. `0` is fire-and-forget. Default 30, maximum 120. |

**Output:** Determined by Gateway `executeSessionSendTool()`. When `waitSeconds > 0`, includes the agent's reply.

**Side effects:** Injects a user message into the target session and triggers an agent turn.

**Behavior:** Requires Gateway context.

---

## Transfer Tools

### gsv__Transfer

Transfer a file between connected nodes and/or the R2 workspace. The tool stays pending until the transfer completes end-to-end.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | `string` | Yes | Source endpoint. Format: `{nodeId}:/path/to/file` for a node filesystem path, or `gsv:workspace/path` for an R2 workspace path. |
| `destination` | `string` | Yes | Destination endpoint. Same format as `source`. |

**Output:** `{ source, destination, bytesTransferred, mime? }`

| Field | Type | Description |
|-------|------|-------------|
| `source` | `string` | Echoed source endpoint. |
| `destination` | `string` | Echoed destination endpoint. |
| `bytesTransferred` | `number` | Total bytes transferred. |
| `mime` | `string` | Detected MIME type of the transferred file (when available). |

**Side effects:** Reads the file from the source endpoint and writes it to the destination endpoint. Creates parent directories on node destinations if needed.

**Behavior:** The Gateway orchestrates the transfer using one of three modes depending on the endpoint types:

| Mode | Source | Destination | Description |
|------|--------|-------------|-------------|
| Node-to-Node | `{nodeId}:/path` | `{nodeId}:/path` | Binary relay through the Gateway. Data flows as binary WebSocket frames from source node to Gateway to destination node. |
| Node-to-R2 | `{nodeId}:/path` | `gsv:workspace/path` | Streaming upload. Source node sends binary frames; Gateway streams into `R2Bucket.put()` via a `TransformStream`. |
| R2-to-Node | `gsv:workspace/path` | `{nodeId}:/path` | Streaming download. Gateway reads from R2 and sends binary frames to the destination node. |

Data transfer uses binary WebSocket frames (not JSON text frames). See the [WebSocket Protocol Reference](./websocket-protocol.md#binary-frames) for the binary frame format.

**Error conditions:**
- Source or destination endpoint is malformed.
- Referenced node is not connected.
- Source file does not exist or is not readable.
- Destination write fails (permissions, disk full).
- Transfer timeout.
