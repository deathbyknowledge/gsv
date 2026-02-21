# Node Tools Reference

Node tools are provided by connected CLI node instances (`gsv node`). Each node registers its tools with the Gateway over WebSocket. Node tools execute on the node's local machine, not on the Gateway.

Tool definitions are in `cli/src/tools/`. The `Tool` trait is defined in `cli/src/tools/mod.rs`.

---

## Tool Namespacing

When a node connects to the Gateway, its tools are namespaced with the node's ID:

```
{nodeId}__{toolName}
```

Examples:
- `laptop__Bash` — Bash tool on the node named `laptop`
- `server__Read` — Read tool on the node named `server`

When multiple nodes are connected, each node's tools are independently namespaced. The agent calls tools by their full namespaced name.

---

## Path Resolution

All file-oriented node tools (Read, Write, Edit, Glob, Grep) resolve relative paths against the node's configured workspace directory. Absolute paths are used as-is.

---

## Bash

Execute shell commands on the node. Supports synchronous execution, background mode, and yield-based async execution with session tracking.

**Tool name:** `Bash`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | `string` | Yes | — | Shell command to execute. Must not be empty. |
| `workdir` | `string` | No | Node workspace | Working directory. Relative paths resolve against the node workspace. |
| `timeout` | `number` | No | `300000` (5 min) | Timeout in milliseconds. When exceeded, the process receives SIGTERM then SIGKILL. |
| `background` | `boolean` | No | `false` | Run in background immediately and return a `sessionId`. |
| `yieldMs` | `number` | No | — | Wait this many milliseconds, then background the process if still running. Clamped to range 10–120000 ms. |

### Execution Model

Commands are executed via the user's login shell (`$SHELL` environment variable, falling back to `/bin/sh`) with flags `-lc`.

- **Synchronous (default):** Blocks until the command completes. Returns full output.
- **Background (`background: true`):** Returns immediately with a `sessionId` for tracking.
- **Yield (`yieldMs`):** Waits up to the specified duration. If the command completes within the window, returns the result. Otherwise, backgrounds the process and returns a `sessionId`.

### Output Constraints

- Maximum captured output: 200,000 characters. Output beyond this limit is truncated (tail preserved).
- Tail buffer: last 4,000 characters, always maintained.
- `truncated` field indicates whether output was truncated.

### Output (completed)

```json
{
  "status": "completed" | "failed",
  "sessionId": "<uuid>",
  "exitCode": <number | null>,
  "signal": "<string | null>",
  "timedOut": <boolean>,
  "startedAt": <timestamp_ms>,
  "endedAt": <timestamp_ms>,
  "durationMs": <number>,
  "output": "<full captured output>",
  "tail": "<last 4000 chars>",
  "truncated": <boolean>,
  "workdir": "<path>"
}
```

### Output (backgrounded/running)

```json
{
  "status": "running",
  "sessionId": "<uuid>",
  "pid": <number>,
  "startedAt": <timestamp_ms>,
  "tail": "<last 4000 chars>",
  "workdir": "<path>"
}
```

### Security

- Commands run with the permissions of the user who started the node process.
- No sandboxing beyond OS-level user permissions.
- Timeout enforcement: SIGTERM is sent first, followed by SIGKILL after 250ms if the process does not exit.

---

## Process

Manage background Bash sessions. This tool is registered alongside `Bash` and provides lifecycle management for backgrounded processes.

**Tool name:** `Process`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `string` | Yes | — | Action to perform. One of: `"list"`, `"poll"`, `"log"`, `"write"`, `"submit"`, `"kill"`. |
| `sessionId` | `string` | Varies | — | Session ID. Required for all actions except `"list"`. |
| `data` | `string` | No | `""` | Data to send for `"write"` and `"submit"` actions. |
| `offset` | `number` | No | `0` | Log line offset for `"log"` action. |
| `limit` | `number` | No | `200` | Maximum log lines for `"log"` action. Minimum 1. |

### Actions

| Action | Description |
|--------|-------------|
| `list` | List all backgrounded sessions (running and recently finished). Sorted by start time, newest first. Finished sessions are retained for 30 minutes. |
| `poll` | Check the status of a backgrounded session. Returns current status, exit code, signal, tail output, and whether still running. |
| `log` | Retrieve output lines from a backgrounded session with offset/limit pagination. Returns total line count and character count. |
| `write` | Write raw data to the stdin of a running backgrounded session. |
| `submit` | Write data to stdin with an appended newline (simulates pressing Enter). |
| `kill` | Send SIGKILL to a running backgrounded session. |

### Error Conditions

- Actions other than `"list"` fail if `sessionId` is not provided.
- `poll`, `log`, `write`, `submit`, and `kill` fail if the session is not found or is not backgrounded.
- `write` and `submit` fail if the session has already exited or stdin is not writable.

---

## Read

Read file contents from the node's filesystem. Supports text files with line-numbered output and image files with structured content blocks.

**Tool name:** `Read`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | Yes | — | Path to the file. Relative paths resolve against the node workspace. |
| `offset` | `number` | No | `0` | Line number to start reading from (0-based). Ignored for image files. |
| `limit` | `number` | No | Total line count | Maximum number of lines to read. Ignored for image files. |

### Output (text files)

```json
{
  "path": "<resolved absolute path>",
  "content": "<line-numbered content>",
  "lines": <number of lines returned>
}
```

Content is returned with each line prefixed by a 1-based line number and tab separator (format: `{lineNum}\t{content}`). Line numbering starts at `offset + 1`.

### Output (image files)

When a file cannot be read as UTF-8 text, the tool reads raw bytes and detects the MIME type via magic-byte sniffing (using the `infer` crate). If the file is an image (`image/*`), the tool returns a structured content result:

```json
{
  "content": [
    { "type": "text", "text": "Image file: photo.png (image/png, 245760 bytes)" },
    { "type": "image", "data": "<base64-encoded image data>", "mimeType": "image/png" }
  ]
}
```

The Session DO detects this structured format and passes the `ImageContent` block through to the LLM as part of the `ToolResultMessage`, allowing the model to see the actual image.

Image file size is capped at 10 MB. Files larger than 10 MB return an error. The `offset` and `limit` parameters are ignored for image files — the full image is always returned.

### Output (non-image binary files)

Binary files that are not images return a descriptive error:

```json
{
  "error": "Binary file: archive.tar.gz (application/gzip, 5242880 bytes) — not a text or image file"
}
```

### Error Conditions

- File does not exist or is not readable.
- Path resolves to a directory.
- Image file exceeds the 10 MB size cap.
- Binary file is not an image type.

---

## Write

Write content to a file on the node's filesystem.

**Tool name:** `Write`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | Yes | — | Path to the file. Relative paths resolve against the node workspace. |
| `content` | `string` | Yes | — | Content to write. |

### Output

```json
{
  "path": "<resolved absolute path>",
  "bytes": <number of bytes written>
}
```

### Side Effects

- Creates parent directories if they do not exist.
- Overwrites the file if it already exists.

### Error Conditions

- Parent directory creation fails (permissions).
- File write fails (permissions, disk full).

---

## Edit

Edit a file by replacing exact text matches on the node's filesystem.

**Tool name:** `Edit`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | Yes | — | Path to the file. Relative paths resolve against the node workspace. |
| `oldString` | `string` | Yes | — | Exact text to find and replace. |
| `newString` | `string` | Yes | — | Replacement text. |
| `replaceAll` | `boolean` | No | `false` | Replace all occurrences. When `false`, replaces only the first occurrence but requires exactly one match. |

### Output

```json
{
  "path": "<resolved absolute path>",
  "replacements": <number of replacements made>
}
```

### Error Conditions

- File does not exist or is not readable.
- `oldString` not found in file content.
- `oldString` found multiple times and `replaceAll` is `false` — error includes the match count and suggests using `replaceAll: true`.

---

## Glob

Find files matching a glob pattern on the node's filesystem.

**Tool name:** `Glob`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pattern` | `string` | Yes | — | Glob pattern (e.g. `"**/*.md"`, `"src/**/*.rs"`). |
| `path` | `string` | No | Node workspace | Directory to search in. Relative paths resolve against the node workspace. |

### Output

```json
{
  "pattern": "<original pattern>",
  "basePath": "<resolved search directory>",
  "matches": ["<path>", ...],
  "count": <number of matches>
}
```

Results are sorted by modification time, newest first.

---

## Grep

Search file contents using regular expressions on the node's filesystem.

**Tool name:** `Grep`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pattern` | `string` | Yes | — | Regex pattern to search for (Rust `regex` crate syntax). |
| `path` | `string` | No | Node workspace | Directory to search in. Relative paths resolve against the node workspace. |
| `include` | `string` | No | — | File name glob pattern to filter files (e.g. `"*.md"`, `"*.{rs,ts}"`). Matched against file name only, not full path. |

### Output

```json
{
  "pattern": "<original pattern>",
  "basePath": "<resolved search directory>",
  "matches": [
    { "path": "<file path>", "line": <1-based line number>, "content": "<matching line>" },
    ...
  ],
  "count": <number of matches>
}
```

When total matches exceed 100, results are truncated and the output includes `"truncated": true` instead of `"count"`.

### Behavior

- Follows symbolic links.
- Skips binary files (files that fail UTF-8 read).
- Matching line content is truncated to 200 characters.

---

## Capability Mapping

Each node tool reports its capabilities to the Gateway. These capability IDs are used for skill eligibility evaluation.

| Capability ID | Tools |
|---------------|-------|
| `filesystem.list` | Glob |
| `filesystem.read` | Read |
| `filesystem.write` | Write |
| `filesystem.edit` | Edit |
| `text.search` | Grep |
| `shell.exec` | Bash, Process |

---

## Host Roles

Each node registers with a host role.

| Role | Description |
|------|-------------|
| `execution` | General-purpose execution host. Provides the standard tool set (Bash, Read, Write, Edit, Glob, Grep, Process). Selected as the primary execution host for tool dispatch. |
| `specialized` | Hosts with specific capabilities or environments. Not selected as primary execution host. |

---

## Runtime Information

Nodes report additional runtime metadata to the Gateway:

| Field | Type | Description |
|-------|------|-------------|
| `hostOs` | `string` | Operating system identifier (e.g. `"darwin"`, `"linux"`, `"windows"`). |
| `hostEnv` | `string[]` | List of environment variable keys available on the host. |
| `hostBinStatus` | `Record<string, boolean>` | Binary availability probed on demand. Key is binary name, value is whether it exists and is executable. |
| `hostBinStatusUpdatedAt` | `number` | Timestamp (ms since epoch) of the last binary probe. |
