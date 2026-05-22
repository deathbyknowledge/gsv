# How to Manage Processes

Use this guide when you need to inspect, reset, kill, or spawn GSV processes.

GSV does not model durable agent work as short-lived chat sessions. Agents run as
processes. Each user has an init process (`init:{uid}`), and additional task
processes can be spawned for isolated work.

## List Processes

```bash
gsv proc list
gsv proc list --uid 1000
```

The list shows process ids, labels, owners, profiles, state, current working
directory, and workspace attachment when available.

## Chat With a Process

Without `--pid`, `gsv chat` targets your init process and waits for streamed
`chat.*` signals:

```bash
gsv chat "Summarize my current workspace."
```

Target a specific process:

```bash
gsv chat --pid task:abc123 "Continue the implementation."
```

Use `proc send` when you only need to enqueue a message and do not want to wait
for streamed output:

```bash
gsv proc send --pid task:abc123 "Run the checks now."
```

## Spawn a Task Process

Create a child process for isolated work:

```bash
gsv proc spawn --label "docs audit" --prompt "Review the how-to docs for stale commands."
```

To spawn under a specific parent:

```bash
gsv proc spawn --parent init:1000 --label "release notes"
```

The command prints the new PID. Use that PID with `gsv chat --pid ...`,
`gsv proc history --pid ...`, or `gsv proc kill ...`.

## Read History

Show recent process messages:

```bash
gsv proc history --limit 30
gsv proc history --pid task:abc123 --limit 50 --offset 0
```

History is active process state stored in the Process Durable Object. Durable
artifacts should live in workspace files, home context, package state, or
repositories.

## Reset a Process

Reset clears the current conversation state while keeping the process entry:

```bash
gsv proc reset
gsv proc reset --pid task:abc123
```

Reset attempts to checkpoint workspace continuity files, archives old messages to
R2 under `var/sessions/{username}/{pid}/...jsonl.gz`, deletes process media, and
starts the next run with fresh message history.

## Kill a Process

Kill stops a non-init process and optionally archives it first:

```bash
gsv proc kill task:abc123
gsv proc kill task:abc123 --no-archive
```

Use `--no-archive` only when the process history is disposable.

## Good Process Patterns

- Use the init process for ongoing personal context and general chat.
- Spawn task processes for bounded work that should not pollute init history.
- Reset when a process has too much stale context but should continue existing.
- Kill when the work is complete and useful state has been written to files.
- Prefer `chat` for interactive use and `proc send` for automation.

## See also

- [Configure an Agent](./configure-agent.md)
- [The Agent Loop](../architecture/agent-loop.md)
- [Process IPC and Scheduler](../architecture/process-ipc-and-scheduler.md)
- [CLI Command Reference](../reference/cli-commands.md)
