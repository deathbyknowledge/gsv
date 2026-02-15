---
name: tmux
description: Use tmux for interactive TUI applications when background shell sessions aren't enough.
metadata:
  { "gsv": { "emoji": "🖥️", "os": ["darwin", "linux"], "requires": { "bins": ["tmux"] } } }
---

# tmux Skill

Use tmux **only for TUI/interactive applications** (codex, vim, htop, etc).
For non-interactive long-running commands, prefer `bash background:true` + `process` actions.

## When to use tmux vs Process

| Scenario                     | Use                                  |
| ---------------------------- | ------------------------------------ |
| `npm run dev`, build scripts | `bash background:true` + `process`   |
| Codex, Claude Code (TUI)     | tmux                                 |
| vim, nvim, htop              | tmux                                 |
| Python/node REPL             | tmux (or Process if basic mode)      |
| ssh interactive session      | tmux                                 |

## Core commands

```bash
# Create window in existing session (trailing colon = auto-index)
tmux new-window -t 0: -n mywindow

# Send commands (Enter sends the keystroke)
tmux send-keys -t 0:mywindow "cd ~/project && codex" Enter

# Read visible output
tmux capture-pane -t 0:mywindow -p

# Read scrollback history (last 500 lines)
tmux capture-pane -t 0:mywindow -p -S -500

# Send control characters
tmux send-keys -t 0:mywindow C-c      # Ctrl+C
tmux send-keys -t 0:mywindow C-d      # Ctrl+D (EOF)
tmux send-keys -t 0:mywindow Escape   # Escape key

# Switch active window
tmux select-window -t 0:mywindow

# Rename window
tmux rename-window -t 0:3 newname

# Cleanup
tmux kill-window -t 0:mywindow
```

## Target syntax

- `-t 0` = window 0 in current session (often wrong)
- `-t 0:` = session 0, auto-assign window index
- `-t 0:mywindow` = session 0, window named "mywindow"
- `-t 0:3.0` = session 0, window 3, pane 0
- `-t sessionname:windowname` = by names

## Detecting completion

TUI apps redraw constantly. Options for detecting "done":

1. **Prompt detection**: Grep for shell prompt (`$`, `❯`, `>>>`)
2. **Context markers**: Some TUIs show status (Codex shows "context left %")
3. **Diff polling**: Capture twice with delay, compare

```bash
# Simple prompt check
tmux capture-pane -t 0:mywindow -p | tail -5 | grep -qE '❯|▶|\$\s*$'
```

## Multi-line input

Some TUIs (like Codex) use multi-line input fields:
- First `Enter` may add a newline within the input
- Second `Enter` (or specific key combo) submits

Experiment with the specific TUI. For Codex, sending the prompt + `Enter` usually works, but may need an extra `Enter` for multi-line prompts.

## Codex example

```bash
# Launch
tmux new-window -t 0: -n codex-task
tmux send-keys -t 0:codex-task "cd ~/project && codex" Enter

# Wait for startup
sleep 3

# Send prompt
tmux send-keys -t 0:codex-task "Fix the login validation bug" Enter

# Poll for output (repeat as needed)
sleep 10
tmux capture-pane -t 0:codex-task -p

# Check if back at prompt (task complete)
tmux capture-pane -t 0:codex-task -p | tail -3 | grep -q "context left"
```

## Parallel agents

```bash
# Spawn multiple agents in separate windows
for i in 1 2 3; do
  tmux new-window -t 0: -n "agent-$i"
  tmux send-keys -t "0:agent-$i" "cd ~/project$i && codex --full-auto 'Fix issue'" Enter
done

# Poll all for completion
for i in 1 2 3; do
  if tmux capture-pane -t "0:agent-$i" -p -S -5 | grep -qE '❯|\$'; then
    echo "agent-$i: done"
  fi
done

# Collect results
for i in 1 2 3; do
  echo "=== agent-$i ==="
  tmux capture-pane -t "0:agent-$i" -p -S -100
done
```

## Naming conventions

Use descriptive names to avoid clobbering human work:
- `gsv-codex-{task}`
- `gsv-repl-python`
- `agent-{short-id}`

## Listing and inspection

```bash
# List all sessions
tmux list-sessions

# List windows in session 0
tmux list-windows -t 0 -F "#{window_index}: #{window_name} (#{window_panes} panes)"

# List all panes
tmux list-panes -a -F "#{session_name}:#{window_name}.#{pane_index}"
```

## Cleanup

```bash
# Kill specific window
tmux kill-window -t 0:mywindow

# Kill specific session
tmux kill-session -t mysession
```
