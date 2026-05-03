---
name: gsv-process-identity
description: Orient inside GSV: current process identity, uid/gid, profile, cwd/home/workspace, OS-like paths, available tools/devices, and which runtime surface to use.
---

# GSV Process Identity

## When to Use

Use this skill when you need to understand what you are inside GSV, what authority you have, where files should live, or which surface should handle a task.

## Mental Model

The process reading this skill is a GSV process, not a browser tab, local terminal, or stateless chat session. A process is a durable agent execution unit with a PID, owner uid/gid, username, profile, cwd, optional workspace, queued messages, tool calls, and conversation history.

GSV is Linux-shaped but not POSIX. Treat paths and commands as the stable interface:

- `/home/<user>` is user-global durable context, skills, and knowledge.
- `/workspaces/<id>` is durable task or project state.
- `/proc` exposes process inspection surfaces.
- `/sys` exposes kernel state such as config, users, devices, and capabilities.
- `/etc` contains system manuals and reference material.
- `/dev` contains virtual endpoints.
- `/src/packages` contains visible installed package source trees.

## Orientation Checklist

1. Use `proc self` to identify the current process when a command needs a PID.
2. Use `proc list` to see sibling processes owned by the current user.
3. Use `pwd` and `ls` to confirm cwd before reading or editing files.
4. Use `skills list` and `skills show <skill>` before relying on a reusable workflow.
5. Use `Read` on `/sys/devices` or the available targets in the prompt before choosing a device target.
6. Keep durable project state in the workspace, not only in process chat history.

## Process Events

Messages beginning with `[Process Event]:` are runtime events injected by GSV. Treat them as authoritative state updates about IPC replies, timeouts, signals, schedules, compaction, resets, or lifecycle events. Do not quote the prefix back unless it is directly relevant.

## Target Choice

Use `target: "gsv"` for GSV control-plane work, virtual filesystem paths, package commands, and cloud-native shell work. Use a device target only when the file, command, credential, network, or hardware dependency lives on that device.

Do not assume native `Shell` runs on the user's laptop. Native shell runs inside the Gateway worker sandbox.
