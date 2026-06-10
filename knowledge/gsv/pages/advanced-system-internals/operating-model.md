# Operating Model

[Advanced System Internals](index.md)

GSV is an OS-shaped cloud computer. The user-facing concepts are apps, files, agents, devices, settings, integrations, and packages. The implementation maps those concepts onto workers, durable runtime state, package source, and connected targets.

## Control Plane

The gateway is the control plane. It handles identity, auth, package management, adapter routing, inference routing, process lifecycle, and system configuration.

Source area:

- `gateway/src/kernel/*`
- `gateway/src/syscalls/*`
- `gateway/src/inference/*`
- `gateway/src/fs/*`

## Durable Agent Runtime

Processes are durable agent runtimes. They hold conversation history, queued input, active runs, pending tool calls, media references, checkpoints, and archives.

Source area:

- `gateway/src/process/do.ts`
- `gateway/src/process/store.ts`
- `gateway/src/process/checkpoint.ts`
- `gateway/src/process/media.ts`

## Desktop And Apps

The web shell hosts the desktop. Builtin packages and package apps provide the actual user work surfaces.

Source area:

- `web/src/session-ui.ts`
- `web/src/session-service.ts`
- `web/src/host-bridge.ts`
- `web/src/gateway-client.ts`
- `builtin-packages/*`

## Targets

Only target-routed file and shell work should move to devices, browser targets, or adapter targets. Control-plane domains remain gateway-facing. When debugging, separate "where the command ran" from "which control-plane operation authorized it."

## Advanced Agent Note

When implementation behavior and the visible system disagree, identify the source of truth first: live runtime state, package source, deployed worker code, local CLI config, a device target, or the repository.
