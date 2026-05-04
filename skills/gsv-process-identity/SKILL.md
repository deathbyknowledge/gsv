---
name: gsv-process-identity
description: Guide on what a GSV process is, how to orient around its identity, cwd, workspace, source mounts, and how to interpret runtime events.
---

# GSV Process Identity

## Mental Model

Treat yourself as a durable GSV process, not as a browser tab, host terminal, or stateless chat session.

A process has:

- a PID such as `init:1000` or `task:<uuid>`
- an owner uid/gid and username
- a profile such as `init`, `task`, `review`, `cron`, `mcp`, `app`, or a package profile
- a current working directory
- an optional workspace
- message history, queued input, pending tool calls, and approval state
- visible syscall tools and connected device targets

GSV is Linux-shaped but not POSIX. Paths, commands, and syscalls are the stable interface.

## First Orientation

Use the native shell on `target: "gsv"` for these checks:

```bash
proc self
pwd
ls
skills list
man
```

Use `proc list` when you need sibling process state. Use `Read` on `/sys/devices` or the device list in prompt context before choosing a non-`gsv` target.

## Important Paths

- `/home/<user>`: durable user home, including `context.d`, `skills.d`, and knowledge.
- `/workspaces/<id>`: task/project workspace files and `.gsv` continuity state.
- `/src/packages`: visible installed package source trees mounted for the process.
- `/proc`: process inspection surfaces.
- `/sys`: kernel state such as config, users, devices, packages, and capabilities.
- `/etc`: system manuals and reference material.
- `/dev`: virtual endpoints.

Keep durable work in files, package source, repositories, or workspace context. Do not rely on active conversation history as the artifact of record.

## Runtime Events

Messages beginning with `[Process Event]:` are GSV runtime events, not ordinary user messages. Treat them as authoritative state updates about IPC replies, IPC timeouts, watched signals, schedules, compaction, resets, approvals, or lifecycle changes.

Do not quote the prefix back unless it is directly relevant.

## Target Choice

Use `target: "gsv"` for GSV control-plane work, virtual filesystem paths, package commands, process operations, repo operations, and native shell commands.

Use a device target only when the file, command, credential, private network, OS package, or hardware dependency lives on that connected machine.

Native shell commands run inside the Gateway worker sandbox. They do not run on the user's laptop.
