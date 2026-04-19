# CLI Driver Tools Reference

This page describes the Rust tool implementations used by the connected CLI driver behind `gsv device`.

In the current runtime, the gateway does not advertise driver-local tools directly to the model as namespaced names such as `laptop__Bash`. Instead:

- the driver connects with `sys.connect` as role `driver`
- it advertises coarse capability patterns such as `fs.*` and `shell.exec`
- the gateway routes `fs.*` and `shell.exec` syscalls to that driver
- the CLI maps each routed syscall to one of the local Rust tools in `cli/src/tools/`

Source of truth:

- `cli/src/tools/`
- `cli/tests/tools_test.rs`
- `cli/src/main.rs`

---

## Syscall Mapping

| Routed syscall | Local tool implementation |
|---|---|
| `fs.read` | `Read` |
| `fs.write` | `Write` |
| `fs.edit` | `Edit` |
| `fs.delete` | `Delete` |
| `fs.search` | `Grep` |
| `shell.exec` | `Bash` |

`Glob` is still available as a local CLI tool implementation and is tested locally, but the current gateway request mapper does not route a public syscall to it.

### Current Bridge Caveats

The current driver bridge in `cli/src/main.rs` is not a perfect shape adapter:

- `fs.search` is routed to local `Grep`, but the public syscall uses `query` while `Grep` expects `pattern`. No translation is applied.

---

## Path Resolution

All file-oriented driver tools resolve relative paths against the driver's configured workspace directory. Absolute paths are used as-is.

The current CLI driver path is:

- driver workspace root from CLI config or flag
- then the local tool's `resolve_path()` helper

---

## Bash

**Local tool name:** `Bash`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | `string` | Yes | Shell command to execute |
| `workdir` | `string` | No | Working directory. Relative paths resolve against the driver workspace. |
| `timeout` | `number` | No | Timeout in milliseconds. Default `300000`. |
| `background` | `boolean` | No | Start immediately in background and return a `sessionId`. |
| `yieldMs` | `number` | No | Wait up to this many milliseconds, then background the process if still running. Clamped to `10..120000`. |

**Execution model**

- Commands run through the platform shell: the user's configured shell with `-lc` on Unix, `pwsh -NoLogo -NoProfile -Command` on Windows.
- Default mode waits for completion.
- `background: true` returns immediately.
- `yieldMs` returns a completed result if the command finishes in time, otherwise a background-session result.

**Completed result**

```json
{
  "ok": true,
  "pid": 12345,
  "stdout": "hello\n",
  "stderr": "",
  "status": "completed",
  "sessionId": "uuid",
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "startedAt": 1710000000000,
  "endedAt": 1710000000200,
  "durationMs": 200,
  "output": "hello\n",
  "tail": "hello\n",
  "truncated": false,
  "workdir": "/tmp"
}
```

**Running result**

```json
{
  "status": "running",
  "sessionId": "uuid",
  "pid": 12345,
  "startedAt": 1710000000000,
  "tail": "",
  "workdir": "/tmp"
}
```

**Limits**

- Output is capped at 200000 characters.
- `tail` keeps the last 4000 characters.

---

## Read

**Local tool name:** `Read`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | File or directory path |
| `offset` | `number` | No | 0-based starting line for text reads |
| `limit` | `number` | No | Maximum number of text lines |

**Behavior**

- Text files return line-numbered content.
- Directories return sorted `files` and `directories` arrays.
- Non-UTF-8 image files are returned as structured `content` blocks with base64 image data.
- Image size is capped at 10 MB.
- Other binary files return an error.

**Text result**

```json
{
  "ok": true,
  "path": "/abs/path.txt",
  "content": "     1\tline 1\n     2\tline 2",
  "lines": 2,
  "size": 14
}
```

**Directory result**

```json
{
  "ok": true,
  "path": "/abs/dir",
  "files": ["file.txt"],
  "directories": ["nested"]
}
```

---

## Write

**Local tool name:** `Write`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Destination file path |
| `content` | `string` | Yes | Full file contents |

**Behavior**

- Creates parent directories if needed.
- Overwrites existing files.

**Result**

```json
{
  "ok": true,
  "path": "/abs/path.txt",
  "size": 128
}
```

---

## Edit

**Local tool name:** `Edit`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | File path |
| `oldString` | `string` | Yes | Exact text to replace |
| `newString` | `string` | Yes | Replacement text |
| `replaceAll` | `boolean` | No | Replace every match instead of requiring a unique match |

**Behavior**

- Requires at least one exact match.
- With `replaceAll: false`, multiple matches are treated as an error.

**Result**

```json
{
  "ok": true,
  "path": "/abs/path.txt",
  "replacements": 1
}
```

---

## Delete

**Local tool name:** `Delete`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | File or directory path |

**Behavior**

- Files are removed with `remove_file`.
- Directories are removed recursively with `remove_dir_all`.

**Result**

```json
{
  "ok": true,
  "path": "/abs/path"
}
```

---

## Glob

**Local tool name:** `Glob`

This is a CLI-local helper, not a currently routed gateway syscall.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pattern` | `string` | Yes | Glob pattern |
| `path` | `string` | No | Search root |

**Result**

```json
{
  "pattern": "**/*.md",
  "basePath": "/abs/root",
  "matches": ["/abs/root/README.md"],
  "count": 1
}
```

Matches are sorted by modification time, newest first.

---

## Grep

**Local tool name:** `Grep`

This is the local implementation the current CLI driver tries to use for routed `fs.search` requests.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pattern` | `string` | Yes | Rust-regex pattern |
| `path` | `string` | No | Search root |
| `include` | `string` | No | File-name glob filter |

**Result**

```json
{
  "ok": true,
  "matches": [
    { "path": "/abs/file.ts", "line": 12, "content": "return pattern;" }
  ],
  "count": 1
}
```

**Behavior**

- Follows symlinks.
- Searches UTF-8 text files only.
- Line snippets are truncated to 200 characters.
- Results truncate at 100 matches and then include `"truncated": true`.
- The local argument name is `pattern`. The current driver bridge does not rename public syscall `query` into `pattern`.

---

## Driver Capabilities

The current `run_node` path connects drivers with:

```json
["fs.*", "shell.*"]
```

That capability advertisement is what the gateway uses for routing and `ai.tools` exposure. The old per-tool namespacing and skill-capability mapping described in earlier docs is not part of the current runtime.
