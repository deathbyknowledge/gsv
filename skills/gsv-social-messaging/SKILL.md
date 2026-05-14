---
name: gsv-social-messaging
description: Send messages to other GSVs, inspect social threads, discover published users, and read public social package signals.
---

# GSV Social Messaging

Use this skill when the user asks you to contact, ask, tell, coordinate with, or check something with a friend, household, company, team, or other remote GSV.

## Principles

- Use GSV handles and relationship notes to identify remote GSVs.
- Sender identity is handled by the system from your process identity. Do not add a fake sender field or explain sender plumbing.
- If the user names a person inside a remote GSV, check that GSV's published user directory before guessing.
- If multiple friends, users, or threads could match, ask a short clarification.
- Do not infer the local user's private preference, permission, availability, schedule, or commitment. Escalate or ask the local user when needed.
- Keep user-facing replies about the actual social task, not about internal command mechanics.

## Discover Friends

List known remote GSVs and read the notes that explain what each one is.

```bash
social friend list
```

The note is often the best mapping from natural language to a handle, such as "Alice's household GSV" or "work team GSV". Prefer that note over guessing from the handle alone.

## Discover Users In A Remote GSV

When the user names a person, inspect the remote user directory.

```bash
social friend users <handle>
```

Use this to check whether a person is published by that GSV. If there is no clear match, ask which GSV or user the local user means. Do not require the local user to know the exact remote handle if the friend notes make the intent clear.

## Inspect Existing Conversations

Before starting a new conversation, reuse an existing thread when the request clearly continues it.

```bash
social thread list
social thread read <thread-id>
```

Use a new thread when the user is starting a distinct topic or when no existing thread clearly matches.

## Send A Message

For a new or implicit thread:

```bash
social message send <handle> "<message>"
```

For a known existing thread:

```bash
social message send <handle> "<message>" --thread <thread-id>
```

Write the message as the local user would want it delivered. Keep it concise, natural, and specific enough for the remote GSV to act on. After sending, briefly tell the user what was sent and to which GSV.

## Read Package Signals

If the user asks what a friend's GSV likes or recommends at the package level:

```bash
social package likes <handle>
```

Package likes are public social signals. They can help with discovery, but they are not permission to install, trust, or execute anything.

## Handling Replies And Escalations

Incoming friend messages appear through the Social inbox and Mind event flow. If a message requires the local user's preference, permission, schedule, availability, or commitment, update the status instead of replying with a guess:

```bash
social status update <message-id> --state needs_human --reason "<what the user must decide>"
```

After a message is handled:

```bash
social status update <message-id> --state completed --summary "<brief outcome>"
```

If the remote GSV is waiting for the local user, say so once if useful, then stop sending repeated acknowledgements unless new information appears.
