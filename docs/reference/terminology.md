# Terminology

GSV uses a few terms consistently across its layers. This document defines each
one and explains how they relate.

## Target

A **target** is the umbrella term for anything an agent can operate on.
Targets are what agents see — they are listed in the prompt under
"Available targets" and addressed with the `target` parameter on tools
like `Shell`, `Read`, `Write`, `Edit`, `Delete`, and `Search`.

Every target has an id, a kind, a set of implemented capabilities, and a
label. Tools and filesystem operations are **target-aware**: the same tool
works on any target by switching the `target` parameter.

Target kinds:

| Kind | What it is | Example |
|---|---|---|
| `gsv` | The native GSV cloud computer. Always present. | `gsv` |
| `native-device` | A user-owned machine running the GSV device daemon (gsvd). Extends GSV with local files, shells, and peripherals. | `laptop` |
| `browser` | An active GSV web shell desktop. Exposes browser-local files, open windows, and browser automation. | `browser:wmEwFV...` |
| `adapter` | An external messaging surface (WhatsApp, Discord, Telegram). Used for explicit platform actions like `send`, `reply`, `react`. | `adapter:whatsapp:personal` |

The shell commands `targets` and `devices` are aliases — they produce the
same output. In context file templates, use `{{targets}}` (preferred) or
`{{devices}}` (backward-compatible alias).

## Device

A **device** is a user-owned machine connected to GSV. Each device
runs a local daemon process (`gsvd`) that:

- Runs as a system service (systemd on Linux, launchd on macOS, Scheduled Task on Windows)
- Connects to the GSV gateway via WebSocket
- Implements syscalls (filesystem operations, shell execution) locally
- Subscribes to exec events and forwards results

When the device daemon connects, the gateway creates a **device record**
in the `devices` SQL table. Each record has an owner, a set of implemented
syscall interfaces (like `fs.*`, `shell.exec`), and an online/offline state.
The gateway maps devices to the `native-device` or `browser` target kinds
that agents see.

The CLI command `gsv device` manages the device daemon (install, start,
stop, status, logs). The internal module is `device_service`.

## Adapter

An **adapter** connects GSV to an external messaging platform (WhatsApp,
Discord, Telegram). Each adapter runs as a Cloudflare Worker (deployed via
`gsv infra deploy -c channel-<name>`) and communicates with the gateway
through `adapter.*` syscalls.

User-facing CLI: `gsv adapter connect`, `gsv adapter status`,
`gsv adapter disconnect`.

The deployment component names (`channel-whatsapp`, `channel-discord`,
`channel-telegram`) use "channel" because they are Cloudflare Channel
Workers. In all other contexts, use **adapter**.

## Agent

An **agent** is an AI identity that runs as a GSV process. Each agent
account has a home directory (`/home/<agent>`) with durable context
files under `context.d/`. Agents are invoked via `proc spawn --as <agent>`
and see the world through their context files and the system prompt.

In context file templates, the running agent's identity is available under
the `program` key (`program.username`, `program.home`, `program.cwd`).
"Program" and "agent" refer to the same thing: the current AI identity.

## Process

A **process** is a running instance of an agent loop. Each process has a
PID, uid/gid identity, current working directory, and message history.
Processes communicate via IPC (`proc call`) and can be scheduled with
cron (`crontab`).

## Gateway

The **gateway** is GSV's central server. It authenticates users and devices,
routes messages between agents and targets, stores device records and
durable state, and runs the kernel that dispatches syscalls. Everything
connects to the gateway via WebSocket.

## Summary

```
User's laptop ──gsvd (device daemon)──▶ Gateway ──▶ Device record ──▶ Agent sees as "target"

WhatsApp ──adapter Worker──▶ Gateway ──▶ Adapter target ──▶ Agent sees as "target"

Browser ──web shell──▶ Gateway ──▶ Device record ──▶ Agent sees as "target"
```

The rule: **agents see targets**. Everything else — devices, adapters,
channels — are implementation details of how those targets are provisioned.
