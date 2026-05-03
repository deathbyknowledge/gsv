---
name: gsv-command-surface
description: Choose and use GSV command surfaces, including native shell commands, package-provided commands, host CLI commands, manuals, process IPC, schedules, packages, wiki, notifications, devices, auth, config, and infra.
---

# GSV Command Surface

## When to Use

Use this skill when you need to choose the right GSV command, distinguish native shell commands from the host `gsv` CLI, or discover package-provided commands.

## Native Shell

The native shell runs through `shell.exec` on `target: "gsv"` inside the Gateway environment. It is the right surface for GSV filesystem paths, package commands, process commands, schedules, notifications, manuals, and package-provided CLI commands.

Core native commands:

- `man [topic]`: list and read built-in manuals.
- `skills list|search|show|files|read`: discover and read reusable workflows.
- `pkg ...`: inspect, import, approve, enable, create, checkout, and commit package source edits.
- `proc ...`: inspect the current process, list processes, compact/fork conversations, and send same-owner process mail or calls.
- `sched ...`: manage Kernel schedules that spawn process work or deliver process events.
- `notify ...`: send and manage user notifications.
- `wiki ...`: manage durable knowledge databases when the Wiki package is installed.
- `codemode ...`: run JavaScript tool scripts that can call `shell(...)` and `fs.*`.

Use `man`, `man pkg`, `man proc`, `man sched`, `man skills`, `man wiki`, `man notify`, or `man codemode` for exact syntax.

## Package Commands

Packages can expose additional native shell commands through their manifest `cli.commands`. Discover installed packages with:

```bash
pkg list
pkg show <package>
pkg manifest <package>
```

If a package command is missing, inspect whether the package is enabled and whether its manifest declares the CLI entrypoint.

## Host CLI

The `gsv` binary runs outside the Gateway on the user's machine or deployment environment. Use it for login, infrastructure, local device service management, and host-to-Gateway chat/shell sessions.

Common host commands:

- `gsv chat [message] [--pid PID]`: send a message to a process and wait for streamed output.
- `gsv shell`: open an interactive native Gateway shell.
- `gsv proc list|spawn|send|history|reset|kill`: manage processes from the host.
- `gsv device run|install|start|stop|status|logs`: manage a local device daemon.
- `gsv auth setup|login|logout|token|link`: first-run setup, login, tokens, and adapter identity links.
- `gsv config get|set`: read or write remote Kernel config.
- `gsv config --local get|set`: read or write local CLI config in `~/.config/gsv/config.toml`.
- `gsv adapter connect|disconnect|status`: manage external adapter accounts.
- `gsv packages sync`: re-seed builtin packages from the mirrored `root/gsv` source.
- `gsv infra deploy|upgrade|destroy`: manage Cloudflare infrastructure.
- `gsv version`: print CLI build metadata.

Use the host CLI only when you are operating from a connected machine or instructing a user/device to run commands. Inside an agent process, prefer the native shell unless the task explicitly requires host-side deployment, local daemon control, or local credentials.

## Choosing a Surface

1. Use native shell commands for GSV OS work.
2. Use package commands for package-owned workflows.
3. Use `skills show <skill>` for procedure-specific guidance before running a nontrivial command sequence.
4. Use `man <topic>` for exact native syntax.
5. Use host `gsv ...` commands for deployment, local device service management, login/session setup, and host automation.
6. Use a device target for shell/filesystem work only when the data or command lives on that device.

Do not confuse `skills` with `gsv skills`. `skills` is a native shell command. The old host CLI `gsv skills` command is removed.
