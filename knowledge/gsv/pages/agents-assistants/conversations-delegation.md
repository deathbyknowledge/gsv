# Conversations & Delegation

[Agents & Assistants](index.md)

A conversation is the normal way a person works with an agent. It can contain messages, files, media, tool results, approvals, and system events. Closing a browser window does not mean the underlying agent work is gone.

## Conversations

Use conversations for:

- Asking an agent to do a task.
- Following a work thread over time.
- Reviewing what an agent tried and what it produced.
- Attaching files or media for the agent to inspect.
- Opening a previous work session and continuing from it.

Long conversations can become harder for an agent to use directly. When information should last, move it into Files or Wiki. A final decision, reusable note, how-to, or project fact belongs somewhere durable.

## Delegation

Delegation lets one agent ask another agent to do bounded work. This is useful when:

- A specialized agent has better instructions or permissions.
- A background task should not block the active chat.
- A package-provided agent owns a package workflow.
- A user wants separate agents for research, editing, operations, or review.

A delegated task should have a clear goal, enough context, and an expected output. Agents should not delegate vague responsibility without a handoff that another agent can complete.

## Queues And Runs

GSV agents can receive more than one message while work is already running. New input is queued until the current run can handle it. Stopping or aborting a run should not be treated as deleting all history; it means the active work was interrupted.

## Practical Tips

- Use short, direct task requests when you need a specific result.
- Use a custom agent when you repeatedly need the same role.
- Use Wiki for reusable instructions or reference material.
- Use Files for artifacts the user should edit, download, or share.
- Stop a process from the GSV console if it is clearly no longer needed.

## For Agents

Keep delegation bounded. Include the task, relevant files or links, constraints, and what should be returned. If the result changes durable state, say where the change was made.
