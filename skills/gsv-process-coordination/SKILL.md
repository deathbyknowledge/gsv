---
name: gsv-process-coordination
description: Guide on how to coordinate durable GSV processes, including spawning, IPC, handoffs, scheduled work, conversation state, and compaction.
---

# GSV Process Coordination

## Process Rules

Processes are durable agent instances. They are not single chat sessions.

Use:

- init process for ongoing user-level continuity
- task processes for bounded work
- review processes for package/code review
- cron processes for scheduled background work
- app processes for app-owned runtime tasks

Keep important outputs in files, workspace state, package source, or knowledge. Active process history is runtime state and can be reset or archived.

## Inspect and Target Processes

Native shell:

```bash
proc self
proc list
```

Host CLI:

```bash
gsv proc list
gsv chat --pid <pid> "message"
gsv proc history --pid <pid> --limit 50
```

Root can inspect other users where authorized. Non-root process IPC is same-owner.

## Spawn Bounded Work

Host CLI shape:

```bash
gsv proc spawn --label "docs audit" --prompt "Review the docs for stale commands."
```

When spawning from inside GSV, include enough assignment context for the child to start without reconstructing the parent conversation. Put durable handoff state in workspace files when it must outlive the process.

New task processes get explicit package source mounts by default. If a caller supplies mounts, that explicit mount scope is the source boundary.

## Same-Owner IPC

Use async process mail when no direct response is required:

```bash
proc send <pid> "message"
```

Use bounded process calls when the source process needs a reply or timeout event:

```bash
proc call <pid> --timeout 60s "message"
```

The source process receives runtime events such as IPC replies or timeouts. Treat `[Process Event]:` entries as process state.

## Schedules

Use Kernel schedules for recurring or delayed work:

```bash
sched list
sched add --name NAME --every 1h "prompt"
sched add --name NAME --cron "0 9 * * *" --timezone UTC "prompt"
sched run <id> --force
sched remove <id>
```

Cron work should avoid interactive assumptions. Write concise summaries or state updates when future runs need continuity.

## Compaction, Reset, Kill, and Handoff

Native `proc` handles process-local coordination:

```bash
proc segments
proc policy
proc compact --keep-last 40 --generate-summary
proc fork --message-id <id> --target <conversation-id>
```

Host `gsv proc` handles process lifecycle:

```bash
gsv proc history --pid <pid> --limit 50
gsv proc reset --pid <pid>
gsv proc kill <pid>
```

Before reset or kill, make sure useful state has been written to workspace files, package source, home context, or knowledge. Workspaces outlive processes.
