# Identity, Context, Media & Approvals

[Agents & Assistants](index.md)

Every agent action has an identity. That identity affects which files the agent can read, which tools it can use, which settings it can change, and what the user sees as the owner of the work.

## Run-As Identity

An agent may be owned by one account while running as another account. In everyday terms:

- The owner is the human or account responsible for the conversation or work.
- The run-as identity is the account whose home, permissions, and agent context are used while executing.

Before changing files, credentials, package settings, or external integrations, an agent should know which identity is active.

## Context And Persona

Context is the standing information that helps an agent behave correctly. It can include role instructions, user preferences, project notes, package-provided instructions, and process-specific instructions.

Use context for stable behavior and concise facts the agent needs often. Do not put large manuals, source dumps, or changing project data directly into always-loaded context. Put those in Wiki or Files and link to them.

## Media

Media can be attached to conversations so an agent can inspect images, audio, documents, or other files. Treat media as part of the working record. If a media file matters after the conversation, save or reference it from Files or Wiki.

## Tool Approvals

Some actions need approval. Examples include running a command, using sensitive credentials, changing access, sending messages externally, or performing package actions that affect the system.

Approval behavior depends on the user, agent, package, tool, and current settings. In an interactive chat, GSV may ask the user. In background automation, a request that requires interactive approval may fail instead of waiting forever.

## For Agents

When a tool is denied or unavailable, explain the blocked action and choose a safer next step. Do not hide approval failures. If a task depends on a different identity or permission, say which one.
