# Schedules, Background Agents & Delegation

[Automation](index.md)

## Scheduled Work

Scheduled work runs later or repeatedly. Use it for:

- Daily or weekly summaries.
- Periodic checks.
- Reminders.
- Maintenance tasks.
- Import or sync routines.

Good schedules include what will run, who owns it, what agent identity is used, and how failures are reported.

## Background Agents

Background agents do not require an open chat window. They are useful for integration handling, recurring tasks, long-running work, and package workflows.

Because no one may be watching, background agents should not depend on interactive approvals. Configure permissions and approval policy before relying on the automation.

## Queues And Runs

Processes handle work in runs. If new messages or events arrive during a run, they can be queued. A queue is not a failure; it is how GSV keeps concurrent input ordered.

If a run is no longer wanted:

- Abort it to stop current work while keeping the process.
- Reset when the conversation should start over but the process should survive.
- Kill only when the process itself should be torn down.

## IPC And Delegation

Inter-process communication and delegation let one process ask another for help. Keep these requests bounded and reviewable. A delegated process should return a result, artifact path, status, or clear failure.

## For Agents

When creating automation, record where the schedule or background work can be inspected. When completing delegated work, report durable outputs and any follow-up action that remains.
