# Automation

[Back to GSV Manual](../../index.md)

Automation lets GSV do work without a person typing every step. It can run scheduled tasks, recurring checks, background agents, delayed jobs, package workflows, and delegated work.

## Main Concepts

- Scheduled work runs at a time or on a recurrence.
- Background agents work without an open Chat window.
- Queues hold messages or tasks until the process can handle them.
- Runs are active units of agent work.
- Process lifecycle controls starting, stopping, resetting, aborting, and killing agent work.
- IPC and delegation let agents or package components ask one another for bounded work.

## Common Workflows

- Schedule a recurring report.
- Run a background agent when new external messages arrive.
- Queue follow-up work from a package or integration.
- Stop a runaway or obsolete process.
- Delegate a subtask to a specialist agent.
- Inspect active and queued work from the GSV console.

## Pages In This Section

- [Schedules, Background Agents & Delegation](schedules-processes-delegation.md)

## For Agents

Automation should have clear ownership, permissions, and failure behavior. Do not create recurring work without making it visible and easy for the user to stop.
