# Orientation

[Back to GSV Manual](../index.md)

GSV is a cloud computer for a person and their agents. It has a desktop, apps, files, accounts, settings, devices, and integrations. You can use it from a browser, connect local machines to it, and let agents work inside it on your behalf.

The most important idea is that GSV is not only a chat window. Chat is one app inside a larger computer. Files can outlive a conversation. Wiki pages can become searchable knowledge. Packages can add apps and commands. Devices can run work where the hardware or private network actually lives. Integrations can bring messages in from external places.

## What Lives Where

- Conversations live in [Agents & Assistants](agents-assistants/index.md) and are usually opened through Chat.
- Documents, repositories, imports, and durable references live in [Files & Knowledge](files-knowledge/index.md).
- Windows, app launching, previews, browser automation, and builtin apps live in [Apps & Desktop](apps-desktop/index.md).
- Cloud, local, browser, and adapter execution locations live in [Devices & Workplaces](devices-workplaces/index.md).
- Human users, agent accounts, permissions, groups, tokens, sessions, and external identity links live in [Accounts & Access](accounts-access/index.md).
- System preferences, AI models, voice, transcription, approvals, and recovery settings live in [Settings](settings/index.md).
- WhatsApp, Discord, Telegram-style test adapters, MCP servers, OAuth accounts, and message routing live in [Integrations](integrations/index.md).
- Scheduled work, recurring tasks, background agents, queues, and delegation live in [Automation](automation/index.md).
- Installed packages, extensions, app entrypoints, package sources, catalogs, and public routes live in [Packages & Extensions](packages-extensions/index.md).

## User-Facing First

Most tasks should start with the surface a user can see:

- Open an app if the task is visual or interactive.
- Open Files if the task is about a file or folder.
- Open Wiki if the task is about long-term knowledge.
- Open the GSV console if the task is about system state, devices, packages, integrations, access, or settings.
- Use Shell when the task is command-driven or the app does not expose the needed operation.

Lower-level implementation details are useful when debugging or developing GSV itself. They are kept in [Advanced System Internals](advanced-system-internals/index.md) so ordinary help pages stay readable.

## Notes For Agents

An agent should assume it is operating inside the user's cloud computer, not outside it. That means:

- Know which account you are running as before changing files or settings.
- Know which target you are using before running commands.
- Put reusable facts in files or Wiki, not only in the current conversation.
- Ask for approval when an operation needs user consent.
- Prefer the user's visible app and settings surfaces before reaching for implementation details.
