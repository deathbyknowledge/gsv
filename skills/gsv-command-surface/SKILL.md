---
name: gsv-command-surface
description: Guide on which GSV command surface to use for a task and when to use native commands, package commands, host CLI commands, man, skills, or device targets.
---

# GSV Command Surface

## Decision Rules

1. Use native shell commands on `target: "gsv"` for GSV OS work.
2. Use package-provided commands when an installed package owns the workflow.
3. Use `man` for exact native shell syntax.
4. Use `skills show <skill>` before a nontrivial reusable workflow.
5. Use host `gsv ...` commands only when operating from a connected machine, deployment environment, or user instruction.
6. Use a device target only when data or execution must happen on that external machine.

Do not confuse the native `skills` command with a host `gsv skills` command. Skills are read inside the Gateway shell with `skills list`, `skills search`, `skills show`, `skills files`, and `skills read`.

## Native Gateway Shell

Native shell runs through `shell.exec` on `target: "gsv"` inside the Gateway environment.

Core commands:

- `man [topic]`: list or read built-in manuals.
- `skills list|search|show|files|read`: discover reusable workflows.
- `pkg ...`: inspect packages, create packages, checkout refs, manage source edits, approve/review packages, public visibility, and sync.
- `proc ...`: inspect processes, send same-owner IPC mail/calls, compact/fork/reset conversations where supported.
- `sched ...`: manage kernel schedules.
- `notify ...`: send and manage user notifications.
- `wiki ...`: manage durable knowledge when the Wiki package is installed.
- `codemode ...`: run JavaScript tool scripts that can call `shell(...)` and `fs.*`.

Useful references:

```bash
man
man pkg
man proc
man sched
man skills
man notify
man codemode
```

## Package Commands

Packages can expose native commands through manifest `cli.commands`. Discover them from package state:

```bash
pkg list
pkg show <package>
pkg manifest <package>
```

If a command is missing, check whether the package is installed, enabled, and declares the CLI entrypoint.

## Host CLI

The `gsv` binary runs outside the Gateway on the user's machine or deployment environment. Use it for login, infrastructure, local device services, and host-to-Gateway sessions.

Common host commands:

```bash
gsv chat [message] [--pid PID]
gsv shell
gsv proc list|spawn|send|history|reset|kill
gsv device run|install|start|stop|status|logs
gsv auth setup|login|logout|token|link
gsv config get|set
gsv config --local get|set
gsv adapter connect|disconnect|status
gsv packages sync
gsv infra deploy|upgrade|destroy
gsv version
```

For accurate reference of the CLI run `curl -H "Accept: text/markdown" https://gsv.space/reference/cli-commands`

Inside a GSV process, prefer native shell and Kernel syscalls. Use host CLI commands only when the task explicitly requires host-side deployment, local daemon control, local credentials, or a command the user/device must run.
