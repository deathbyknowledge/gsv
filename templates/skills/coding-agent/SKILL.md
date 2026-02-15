---
name: coding-agent
description: Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent via background shell sessions for programmatic control.
metadata:
  {
    "openclaw": { "emoji": "🧩", "requires": { "anyBins": ["claude", "codex", "opencode", "pi"] } },
  }
---

# Coding Agent (bash-first)

Use `bash` for coding-agent workflows. For long tasks, run in background and monitor with `process`.

## Bash parameters

| Parameter    | Type   | Description                                           |
| ------------ | ------ | ----------------------------------------------------- |
| `command`    | string | Shell command to execute                              |
| `workdir`    | string | Working directory (defaults to node workspace)        |
| `timeout`    | number | Timeout in milliseconds                               |
| `background` | bool   | Return immediately with `status=running` + `sessionId` |
| `yieldMs`    | number | Wait this many ms, then return running if still active |

## Process actions

| Action   | Description                                     |
| -------- | ----------------------------------------------- |
| `list`   | List running/recent background sessions         |
| `poll`   | Check if session is running or finished         |
| `log`    | Read session logs (supports `offset`/`limit`)   |
| `write`  | Write raw stdin data to running session         |
| `submit` | Write data + newline (Enter)                    |
| `kill`   | Kill running background session                 |

## Basic patterns

```bash
# One-shot
bash workdir:~/project command:"codex exec 'Add retries to API client'"

# Start long task in background
bash workdir:~/project background:true command:"codex exec --full-auto 'Build settings page'"
# -> returns sessionId

# Monitor
process action:log sessionId:XXX
process action:poll sessionId:XXX

# Send input when needed
process action:write sessionId:XXX data:"y"
process action:submit sessionId:XXX data:"yes"

# Stop if needed
process action:kill sessionId:XXX
```

## Codex notes

```bash
# Scratch prompt (Codex needs a git repo)
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init && codex exec "Your prompt here"

# Real project
bash workdir:~/project command:"codex exec --full-auto 'Implement JWT refresh flow'"
```

## Safety rules

1. Respect user-selected coding agent.
2. Prefer `workdir` to keep scope tight.
3. For long tasks, use `background:true` and report progress from `process`.
4. If you kill a session, tell the user immediately and explain why.
5. Do not silently switch from orchestration mode to hand-editing code unless user asks.
