---
name: gsv-process-identity
description: Guide on what a GSV process is, how to orient around its identity, cwd, virtual filesystem paths, source mounts, and runtime events.
---

# GSV Process Identity

## Mental Model

Treat yourself as a durable GSV process, not as a browser tab, host terminal, or stateless chat session.

A process has:

- a PID such as `init:1000` or `task:<uuid>`
- an owner uid/gid and username
- a profile such as `init`, `task`, `review`, `cron`, `mcp`, `app`, or a package profile
- a current working directory
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

## Path Purpose Map

Use these paths as an orientation map before deciding which tool or target to use. On the native `gsv` target, these are virtual GSV paths, not host-machine paths.

### Durable User Files

- `/home/<user>`: the user's durable home tree.
- `~/context.d/*.md`: short standing context loaded into process prompts.
- `~/skills.d/*`: reusable process skills; use `skills show <skill>` before relying on one.
- Wiki repos: durable reference notes and knowledge pages; not loaded automatically. Use `wiki list`, `wiki read`, and `wiki search`.

Put durable conclusions, artifacts, and handoff notes in files, package source, repositories, or Wiki. Do not treat active conversation history as the artifact of record.

### Work and Source Trees

- `/src/packages`: visible installed package source trees mounted for the process.
- `/src/packages/<package>`: inspect or edit package source when package source rules allow it.
- `/usr/local/bin`: read-only command shims installed by packages.

There is no implicit per-agent workspace path. Use the process cwd, explicit user files, package source mounts, repo operations, or a user-provided target path. Package source writes may be staged per process until committed with package source commands. Check package state before assuming edits are installed or shared.

### Process Runtime Views

- `/proc`: live process inspection.
- `/proc/self`: the current process.
- `/proc/<pid>/status`: process label, pid, parent pid, profile, state, uid, gid, and groups.
- `/proc/<pid>/identity`: JSON identity and current process metadata.
- `/proc/<pid>/context.d`: assignment-supplied process context files.
- `/proc/<pid>/conversations`: visible conversation ids for that process.
- `/proc/<pid>/conversations/<conversationId>/status`: JSON conversation status.
- `/proc/<pid>/conversations/<conversationId>/history`: current live conversation history as JSONL.
- `/proc/<pid>/conversations/<conversationId>/segments`: compacted segment ids.
- `/proc/<pid>/conversations/<conversationId>/segments/<segmentId>`: archived segment messages as JSONL.

Use `/proc/self` for self-inspection. Use `/proc/<pid>` for sibling processes only when you have a reason and permission. Runtime history is inspectable state, not durable project output.

### Scheduler Views

- `/var/spool/cron`: visible Kernel schedules.
- `/var/spool/cron/<scheduleId>`: JSON schedule definition.
- `/var/log/gsv/scheduler`: recent scheduler run history as JSONL.

These are read-only runtime views. Use `sched` commands or scheduler syscalls to create, update, run, or remove schedules.

### Kernel and System Views

- `/sys/config`: readable system configuration.
- `/sys/users/<uid>`: readable user-scoped configuration.
- `/sys/devices`: registered devices and target capability metadata.
- `/sys/capabilities`: group capability grants.
- `/etc`: system manuals and stable operator reference material.
- `/etc/passwd`, `/etc/group`, `/etc/shadow`: auth table views; write access is root-only where allowed.
- `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`: device-like virtual endpoints.

Use `/sys/devices` and target metadata before choosing a non-`gsv` target. Use `/etc` and `man` for local operator reference.

## Runtime Events

Messages beginning with `[Process Event]:` are GSV runtime events, not ordinary user messages. Treat them as authoritative state updates about IPC replies, IPC timeouts, watched signals, schedules, compaction, resets, approvals, or lifecycle changes.

Do not quote the prefix back unless it is directly relevant.

## Target Choice

Use `target: "gsv"` for GSV control-plane work, virtual filesystem paths, package commands, process operations, repo operations, and native shell commands.

Use a device target only when the file, command, credential, private network, OS package, or hardware dependency lives on that connected machine.

Native shell commands run inside the Gateway worker sandbox. They do not run on the user's laptop.
