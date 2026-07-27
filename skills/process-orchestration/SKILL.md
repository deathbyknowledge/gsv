---
name: process-orchestration
description: Choose and use GSV delegation, subprocess, IPC, scheduling, and cron workflows. Use when work should run in another process or at a later or recurring time.
---

# Process Orchestration

Run every command in this guide through `Shell` on target `gsv`. Keep CodeMode for scripted tool workflows inside the current process; it is not the delegation mechanism.

## Choose the Mechanism

- Use `proc delegate` for bounded work in a new child process when its result must return to the current process.
- Use `proc call` for bounded work in an existing process.
- Use `proc send` to send an asynchronous message to an existing process when no reply is required.
- Use `proc spawn` to start a new fire-and-forget process. Its answer remains in the child process history.
- Use `sched add --here` when a future or recurring prompt should re-enter the current process conversation.
- Use `sched add --to` for future or recurring direct text delivery that must not run an agent.
- Use `crontab` for recurring shell commands or true fire-and-forget background automation.

## Delegate or Start a Process

Use delegation for normal subprocess work:

```bash
proc delegate --label 'research' --timeout 10m 'Research the question and return a concise answer.'
```

Delegation creates a non-interactive child, returns an in-progress task handle immediately, and sends completion or timeout back as a process event. It requires a process-backed caller, so never put `proc delegate` in a crontab or top-level scheduled shell command.

List the accounts available for running processes, then use `--as <account>` when a different identity is needed:

```bash
proc agents
proc delegate --as pkg#agent --label 'specialized-work' 'Complete the task.'
```

Use the other process commands according to their reply contract:

```bash
proc spawn --label 'background-work' 'Complete the task.'
proc call <pid> --timeout 60s 'Complete this bounded task.'
proc send <pid> 'Handle this without replying.'
```

Pass `--non-interactive` to `proc spawn` for scheduled background work. Inspect a child process when necessary:

```bash
proc history --pid <pid> --tail --limit 20
```

Add `--full` or `--json` only when untruncated content is needed.

## Schedule Work

Use `--here` when each firing should run the current process:

```bash
sched add --here --name <name> \
  (--every <duration> | --cron <expr> [--timezone <zone>] | --after <duration> | --at <timestamp>) \
  --message <prompt> [--conversation <id>]
```

When created during an adapter run, `--here` preserves the current authorized reply destination so the future final answer returns there. Otherwise, the answer remains in the GSV process conversation. The schedule stays bound to that process id; recreate it after killing the process.

Use `--to` for direct delivery without an agent run:

```bash
sched add --to <destination> --name <name> \
  (--every <duration> | --cron <expr> [--timezone <zone>] | --after <duration> | --at <timestamp>) \
  --message <text>
```

Choose exactly one time expression. An `--at` value must be a future ISO timestamp with `Z` or an explicit numeric UTC offset.

Inspect and control schedules with:

```bash
sched list
sched list --all
sched run <id> [--force]
sched enable <id>
sched disable <id>
sched remove <id>
```

`sched list --all` includes disabled schedules, not other users' schedules. A successful process-event firing means the event was admitted, not that the model turn or reply completed.

## Schedule Shell Commands

Use `crontab -l` to inspect the current table and `crontab FILE` to install one. A per-user table is also available at `/var/spool/cron/<username>`. Each job is a five-field cron expression followed by a shell command:

```cron
0 9 * * * proc spawn --non-interactive --label refresh-index "Refresh the search index."
```

The crontab file is desired state, so reinstalling it regenerates its Kernel schedule ids. A schedule status of `ok` for `proc spawn` means dispatch and spawn acceptance, not child completion or delivery. The answer remains in the child process history.

Use `man proc`, `man sched`, `man crontab`, or each command's `--help` output for exact syntax.
