# Conversations and Process Activity

GSV presents one personal intelligence while retaining inspectable agent processes. That requires
two related records with different jobs:

- A **conversation** is the canonical user-facing message stream.
- **Process activity** is the execution record: model reasoning, draft text, tool calls and results,
  errors, retries, and terminal choices.

Conversation messages do not belong to a Process. A Process handles an interaction and each
canonical message records the relevant PID and run ID, but killing that Process does not delete the
conversation. Users can inspect the referenced Process while it exists or read its archive later.

## Conversation kinds

The Kernel owns the conversation directory and membership:

- **Ship** is the stable conversation with the user's personal intelligence. Web, Desktop, CLI,
  Telegram, WhatsApp, and other private surfaces all contribute to the same Ship message stream.
  The current personal Process is replaceable; the Ship conversation is not.
- **Work** is a conversation handled by one explicit interactive work Process. Opening Work does not
  replace Ship or redefine the personal intelligence.
- **Group** is tied to one normalized adapter surface and can retain multiple account and Process
  members. Current authorization remains owner-scoped, while the membership schema can represent
  later multi-user and multi-Process conversations.

Delegated Process work is not copied into Ship. A child returns a typed Process event to its caller;
the personal intelligence decides whether the result should become a canonical Message, cause more
work, or remain silent.

## Explicit delivery

Ordinary assistant text is Process activity. It is never implicitly sent to a user. Every
human-facing model turn ends with exactly one direct Shell terminal command:

- A literal block commits one canonical user-visible message without interpreting its contents:

  ```bash
  message send <<'GSV_MESSAGE'
  your user-visible response
  GSV_MESSAGE
  ```

- `message silence` records that no user-visible response is useful.

The Process recognizes these exact, literal commands inside a direct `Shell` call before normal
shell dispatch. They do not require `shell.exec` capability or approval, cannot target a device, and
cannot be invoked indirectly through CodeMode. The model receives only the fixed Read, Write, Edit,
Delete, Search, Shell, and CodeMode surface. If a generation returns ordinary text without a terminal
command, the Process adds one `[GSV EVENT]` correction and retries once. A second omission ends the
run with an inspectable error instead of looping indefinitely. An attempted but malformed terminal
command has its own five-attempt recovery budget. Delivery failures are tracked separately, so they
cannot exhaust either omission or command correction.

An IPC call has no implicit human delivery. Ordinary final assistant text becomes the durable
Process result and returns to the caller as `ipc.reply`; it does not impersonate a user or append
to Ship. `proc.run.finished` records `result` and `delivery` independently, so silence or failed
human delivery cannot erase a caller result.

## Directed endpoints and synchronization

The run route identifies the endpoint that caused the interaction. It controls immediate delivery,
not conversation ownership:

- The originating Web/Desktop/CLI connection receives `message.started` and `message.delta` once
  the terminal command has been validated, then `message.committed`.
- Other signed-in clients receive only the committed canonical message as synchronization. They do
  not play a notification or act as though the response was directed to them.
- Adapters buffer Process output and deliver only the committed message. Provider-specific reply
  threading remains transport metadata.
- A background Personal run without a conversation-origin route may use the last authorized private
  adapter destination. A disconnected client-origin conversation never falls back to an adapter.

The same rule applies to approvals: a client-origin HIL request does not jump to Telegram if its
connection disappears, while a background Personal event may use the authorized private fallback.

Opening a Process activity inspector calls `proc.observe`. Raw Process signals then reach that
specific client in addition to any connection that owns the active run. Closing the inspector calls
`proc.unobserve`. Observation is explicit so every connected client does not receive every model
token, reasoning block, and tool event. Idle owner clients may receive a content-free `proc.changed`
invalidation so process inventories refresh; private activity fields remain routed or observed only.

## Storage and retention

The Kernel Durable Object stores only the conversation directory, membership, handler, surface
mapping, and latest sequence. Each conversation has its own installation-scoped Conversation Durable
Object:

- SQLite retains the newest 1,000 canonical messages for indexed, strongly consistent access.
- When the hot set grows past that limit, the oldest 500 messages become an immutable gzip JSON
  segment in installation-scoped R2.
- SQLite retains the segment index and idempotency receipts, so history paging and retried appends
  remain stable across the hot/archive boundary.
- Conversation messages store immutable resource references. The Process retains an exact source
  revision in the run-as agent archive before committing it, so the bytes remain readable after
  temporary Process cleanup without a second conversation-owned copy.

The archive operation uploads and verifies the immutable R2 object before a synchronous SQLite
commit records the segment and removes its hot rows. A failed upload or changed candidate leaves the
SQLite messages intact.

Process history keeps its existing lifecycle and archive policy. Conversation history and Process
activity can therefore rotate independently without conflating what the user saw with how the work
was performed.

## Authorization

Public `conversation.*` syscalls require a direct authenticated user client. Process callers cannot
append user messages, read a user's canonical conversation through those syscalls, or recursively
admit themselves. Adapter ingress and Process message commits use private Kernel-owned paths after
the Kernel has resolved owner, route, Process, and conversation identity.

Conversation IDs are opaque. Installation identity remains the outer physical boundary for the
Kernel, Conversation Durable Object names, and R2 keys.
