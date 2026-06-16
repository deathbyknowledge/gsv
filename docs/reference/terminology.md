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
| `native-device` | A user-owned machine running the GSV node daemon (gsvd). Extends GSV with local files, shells, and peripherals. | `laptop` |
| `browser` | An active GSV web shell desktop. Exposes browser-local files, open windows, and browser automation. | `browser:wmEwFV...` |
| `adapter` | An external messaging surface (WhatsApp, Discord, Telegram). Used for explicit platform actions like `send`, `reply`, `react`. | `adapter:whatsapp:personal` |

The shell commands `targets` and `devices` are aliases — they produce the
same output.

## Device

A **device** is the gateway-side record for a machine that has connected
to GSV. It is stored in the `devices` SQL table. Each device has an owner,
a set of implemented syscall interfaces (like `fs.*`, `shell.exec`), and an
online/offline state.

Devices are registered when the node daemon (gsvd) running on a user's
machine connects to the gateway. The gateway maps devices to the
`native-device` or `browser` target kinds that agents see.

## Node (Node Daemon)

A **node** is the local daemon process (`gsvd`) that runs on a user's
machine and connects it to GSV as a device. The node daemon:

- Runs as a system service (systemd on Linux, launchd on macOS, Scheduled Task on Windows)
- Connects to the GSV gateway via WebSocket
- Implements syscalls (filesystem operations, shell execution) locally
- Subscribes to exec events and forwards results

The CLI command `gsv device` manages the node daemon (install, start,
stop, status, logs). The internal module is `node_service`.

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

## Process

A **process** is a running instance of an agent loop. Each process has a
PID, uid/gid identity, current working directory, and message history.
Processes communicate via IPC (`proc call`) and can be scheduled with
cron (`crontab`).

## Summary

```
User's laptop ──gsvd (node daemon)──▶ Gateway ──▶ Device record ──▶ Agent sees as "target"

WhatsApp ──adapter Worker──▶ Gateway ──▶ Adapter target ──▶ Agent sees as "target"

Browser ──web shell──▶ Gateway ──▶ Device record ──▶ Agent sees as "target"
```

The rule: **agents see targets**. Everything else — devices, nodes, adapters,
channels — are implementation details of how those targets are provisioned.
