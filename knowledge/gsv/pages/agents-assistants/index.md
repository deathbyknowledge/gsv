# Agents & Assistants

[Back to GSV Manual](../../index.md)

Agents are accounts that can work inside GSV. They can chat, read and write files they are allowed to access, use tools, run commands, call package features, and delegate work to other agents.

GSV uses several kinds of agents:

- Personal agents are the default assistants for a human account.
- Custom agents are named agents you create for a purpose, style, or area of responsibility.
- Package agents are supplied by packages and are usually scoped to what that package is allowed to do.
- Background agents run because of schedules, queues, package workflows, or delegated tasks rather than a live chat.

## Common Workflows

- Start or continue a conversation in Chat.
- Create a custom agent when you want a stable persona, recurring job, or narrower permissions than your personal agent.
- Delegate a task when one agent should ask another agent to do bounded work.
- Attach media or files to a conversation when the agent needs to inspect them.
- Review tool approvals when an agent wants to run a command, access sensitive data, or perform an external action.
- Use the GSV console when you need to inspect running agents or stop long-running work.

## Pages In This Section

- [Conversations & Delegation](conversations-delegation.md)
- [Identity, Context, Media & Approvals](identity-context-approvals.md)

## Agent Notes

Agents should treat conversation history as working memory, not permanent storage. Important outcomes should be written to files, Wiki pages, package source, or another durable location that the user can inspect later.

For implementation details about process state, queues, tool calls, and cancellation, see [Advanced System Internals](../advanced-system-internals/index.md).
