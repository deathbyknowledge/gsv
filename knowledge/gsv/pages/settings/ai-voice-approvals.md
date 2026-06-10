# AI, Voice & Approval Settings

[Settings](index.md)

## AI Model And Provider

AI settings decide which provider and model agents use, along with generation options such as reasoning effort, token limits, and context size.

Use user-specific settings when one person wants a different model from the system default. Use system settings when the default should apply broadly.

Common reasons to change AI settings:

- A task needs a more capable model.
- A task needs a faster or cheaper model.
- The user has a provider-specific API key.
- A package or agent requires a particular model family.
- Context limits need to fit larger reference material.

## Voice And Transcription

Voice settings control speech output. Transcription settings control how audio becomes text. These settings matter for voice agents, audio notes, media workflows, and accessibility.

Before enabling voice or transcription, check whether the provider, model, and account permissions are configured.

## Approval Behavior

Approval settings control how tools behave:

- Ask: request confirmation before doing the action.
- Allow: run without asking when policy permits it.
- Deny: block the action.

Approval is especially important for shell commands, external messages, credential access, package changes, device actions, and file operations with broad impact.

Interactive conversations can ask the user. Background jobs should be configured so they do not depend on approvals that require a live person.

## For Agents

If a model, voice, transcription, or approval setting blocks a task, explain the specific missing capability or policy instead of retrying blindly.
