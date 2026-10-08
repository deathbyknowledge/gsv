# Conversations and Process Activity

GSV presents one personal intelligence while retaining inspectable agent processes. That requires
two related records with different jobs:

- A **conversation** is the canonical user-facing message stream.
- **Process activity** is the execution record: model reasoning, draft text, tool calls and results,
  errors, retries, and terminal choices.

Conversation messages do not belong to a Process. A Process handles an interaction and each
canonical message records the relevant PID and run ID, but killing that Process does not delete the
conversation. Users can inspect the referenced Process while it exists or read its archive later.

Web and Desktop render Ship's Markdown code blocks at a readable monospace size with a copy action.
Long lines scroll inside the block. Copy preserves indentation and internal line breaks without
adding the renderer's final newline to the clipboard.
Chat renders human messages as plain text with clickable web URLs. External web links in human
messages and Ship's Markdown replies open in a new tab.
When the reader scrolls above the latest chat message, a small button returns the transcript to
the bottom and resumes following new replies.

## Conversation kinds

The Kernel owns the conversation directory and membership:

- **Ship** is the stable conversation with the user's personal intelligence. Web, Desktop, CLI,
  Telegram, Slack, and other private surfaces all contribute to the same Ship message stream.
  The current personal Process is replaceable; the Ship conversation is not. In the web and
  Desktop clients an empty Ship conversation shows the interface greeting ("Welcome to the ship."
  / "I am the ship. Who are you?"); the CLI and messengers show none. Nothing is sent on the
  user's behalf, and the Ship's onboarding responsibility tells it which surfaces saw the greeting
  so it can treat the first message as the answer or introduce itself first.
- **Work** is a conversation handled by one explicit interactive work Process. Opening Work does not
  replace Ship or redefine the personal intelligence.
- **Group** is tied to one normalized adapter surface and can retain multiple account and Process
  members. Current authorization remains owner-scoped, while the membership schema can represent
  later multi-user and multi-Process conversations.
- **Contact** is a conversation with an authenticated person on another space. It has no mandatory
  Process handler. People owns its presentation; accepting a contact alone starts no agent work.

The Kernel separately admits contact messages to Ship attention. A human can enable standing
handling for one contact generation. Enabling it does not create work or wake Ship; the next
incoming message creates a responsibility and later messages reuse that active record. After
handling is disabled or completed, new work starts only on another incoming message while
the preference is enabled; terminal records stay terminal. An outgoing message
can instead bind to an existing owned Ship responsibility awaiting a reply. Exact reply references
select that responsibility; without a reference, only one active task can be selected unambiguously.
Both human and Process-authored replies may continue authorized work. A receipt or duplicate message
never creates another responsibility. Revocation ends standing handling and returns unfinished tasks
to Ship with the disconnection recorded. A replacement contact generation requires a fresh handoff.

Delegated Process work is not copied into Ship. A child returns a typed Process event to its caller;
the personal intelligence decides whether the result should become a canonical Message, cause more
work, or remain silent.

## Explicit delivery

Ordinary assistant text is Process activity. It is never implicitly sent to a user. Human-facing
delivery and run completion are separate operations:

- The `Send` tool commits a canonical user-visible message without interpreting its contents. With
  `text` alone the run remains active, so the intelligence can update the user and then continue
  working; with `yield: true` the run finishes after the message, preserving its durable Process; with
  `yield: true` and no text it finishes without another user-visible message. `attach` names files to
  send, a path on the cloud home or `target:path` for a file on a place; each is referenced where it
  lives through `fs.read` in its `reference` representation, retained into the process archive, and sent with the message, or the send is
  refused naming the file that could not be read. Those reads obey the person's tool approval rules the
  way a Read does: a file that would need approval is refused until it has been read once.
- The same three actions exist as commands, so a person or a script can do what the model does. A
  literal block sends and leaves the run active, `yield` finishes it, and a final message composes both
  with ordinary shell success semantics:

  ```bash
  message send <<'GSV_MESSAGE'
  your user-visible response
  GSV_MESSAGE
  ```

  ```bash
  message send <<'GSV_MESSAGE' && yield
  your final user-visible response
  GSV_MESSAGE
  ```

The Process recognizes a `Send` call, and these exact commands inside a direct `Shell` call, before
normal shell dispatch. They do not require `shell.exec` capability or approval, cannot target a device, and cannot
be invoked indirectly through CodeMode. The model receives only the fixed Read, Write, Edit, Delete,
Search, Shell, CodeMode, and Send surface. A successful send returns a tool result and schedules the
next model turn unless it yielded. If a generation stops without yielding, the Process adds a
`[GSV EVENT]` correction naming `Send`, up to three times, with the tool set unchanged so the cached
prompt prefix survives. A further omission ends the run with an inspectable error instead of looping
indefinitely, and the person receives a short notice that a reply was written but not sent. A malformed message or run-control command has its own
five-attempt recovery budget. Delivery failures are tracked separately, so they cannot exhaust either
omission or command correction. Each send has a stable action id, allowing several exactly-once
Messages in one run and safe replay after an uncertain response.

An IPC call has no implicit human delivery. Ordinary final assistant text becomes the durable
Process result and returns to the caller as `ipc.reply`; it does not impersonate a user or append
to Ship. `proc.run.finished` records `result` and `delivery` independently, so silence or failed
human delivery cannot erase a caller result.

## Directed endpoints and synchronization

The run route controls immediate delivery, not conversation ownership. Explicit Work, group and
contact destinations remain fixed. Personal Ship replies follow the owner's current reply preference:

- The selected Web/Desktop/CLI connection receives `message.started` and `message.delta` while
  the model is still writing the message, then `message.committed`.
- A started stream stays on its original connection through its deltas and abort. Switching clients
  changes the committed reply's destination; it does not hand over a partial stream. A commit
  replaces that draft through the ordinary conversation synchronization.
- Other signed-in clients receive only the committed canonical message as synchronization. They do
  not play a notification or act as though the response was directed to them.
- Adapters buffer Process output and deliver only the committed message. Provider-specific reply
  threading remains transport metadata.
- A human message to Ship selects its originating endpoint. Real foreground input in Web or Desktop
  also selects that client, at most once every 30 seconds; connecting, focusing a window, history
  reads and keepalives do not. This preference survives the end of a run and Process replacement.
- When the selected client disconnects or has been inactive for five minutes, Ship uses the owner's
  last authorized linked private messenger destination. A new messenger message selects that
  messenger; returning to interact with the app selects the app again. Without a usable destination,
  the message remains in canonical history.
- Idle expiry includes 30 seconds of reporting grace so throttled input cannot cause an early
  fallback. Accepted inputs preserve their preference decision across retries without replacing
  newer activity. The Kernel orders input before asynchronous preparation, so overlapping sends
  select the newest input regardless of which preparation finishes first.
- Each outgoing message records its delivery decision before the canonical append. Retrying an
  uncertain append does not notify a different endpoint after the preference changes. Receipts expire after
  30 days, independently of the lifetime of canonical conversation history.

Streaming begins before the Send call is complete. As the model writes the call's arguments, the
Process reads the `text` string out of the partial JSON and appends each newly completed run of
characters to a message projection keyed by the tool call id, so the person watches the reply grow
word by word. Escape sequences and surrogate pairs are released only once whole, and members that
precede `text` are skipped. When the call completes, the committed text is reconciled against what
was streamed: a match sends the remainder as one last delta, a difference aborts the projection so
the client drops the preview and shows the committed message. A Send that fails validation, a
generation that fails or retries, and a run that is interrupted, superseded, reset or killed also abort
their projections, so no partial text outlives its message. Adapters never see the projection.

Sending a message and yielding remain separate even when requested in one call. If
outstanding responsibilities prevent a requested yield, the valid message still commits
and stays visible while the Process continues working. The tool result identifies the
remaining work and confirms that the message was sent, so Ship can finish or defer the
work and yield without sending the same reply again.

New Ship approval notifications use the same reply preference and authorized messenger fallback.
Delegated Work retains its inherited approval route. An already queued adapter delivery keeps its
chosen destination through retries; changing activity does not replay old notifications.

In Web and Desktop, new approval requests scroll into view without moving the composer cursor or
changing its draft. Use the buttons to decide, or `y` / `n` when not typing. The request has its own
transcript row, independent of messages and runtime activity. Approvals from delegated work appear
above the composer. Ship, delegated work and Fleet share one approval card: the
action's purpose comes first, with command or request details folded underneath.
The **full request** fold preserves every argument, including structured MCP
parameters, mail bodies and execution options. Requests without a readable
summary still expose their complete request in the details fold.
Shell approvals on a specific target also offer **always allow**. Its tooltip
explains that this remembers all shell commands on that target for the requesting
process, not just the displayed command. Other processes and targets still use
their own approval rules; ordinary approval and denial never remember a rule.

Opening a Process activity inspector calls `proc.observe`. Raw Process signals then reach that
specific client in addition to any connection that owns the active run. Closing the inspector calls
`proc.unobserve`. Observation is explicit so every connected client does not receive every model
token, reasoning block, and tool event. Idle owner clients may receive a content-free `proc.changed`
invalidation so process inventories refresh; private activity fields remain routed or observed only.
The inspector combines `proc.history` values with the bounded `proc.trace` span tree: timing stays a
small Process-owned index, while reasoning, tool arguments, results, and messages retain one storage
owner and are resolved only when a user inspects a span.

## Storage and retention

Instrument's People indicator and Zen activity strip read the ordinary owner-scoped
inbox with `attentionOnly: true` and the incoming request list. The Kernel filters
unread, active, unmuted, unblocked conversations before pagination; the caller selects
the usual archived state. Existing `conversation.changed`, `contact.changed` and
`approach.changed` signals invalidate those bounded reads, and reconnect refreshes
them. Attention survives reload through the private inbox projection. Zen and People
observe the same paginated conversation cache; Zen has no separate live-message or
replied-notice store. Only unfinished reply drafts and their submitted send identities
remain local. A draft retains the read position where it began, so reads elsewhere do
not hide its context or pull older read history into the panel. Each send retains the
exact sequence it answers, so a later arrival stays unread when that reply completes.
A failed read update leaves the inbox authoritative
and surfaces the error without repeating the successful send.

The Kernel Durable Object stores the conversation directory, membership, optional handler, surface
mapping, latest sequence and private inbox projection. Contact previews, read positions and archive
state stay in that projection; canonical messages have one owner. Each conversation has its own installation-scoped Conversation Durable
Object:

- SQLite retains the newest 1,000 canonical messages for indexed, strongly consistent access.
- When the hot set grows past that limit, the oldest 500 messages become an immutable gzip JSON
  segment in installation-scoped R2.
- SQLite retains the segment index and idempotency receipts, so history paging and retried appends
  remain stable across the hot/archive boundary.
- Contact messages retain authenticated origin, authorship and reply references. Their origin index
  maps an immutable remote message identity to the local sequence even after archival.
- Conversation messages store immutable resource references. The Process retains an exact source
  revision in the run-as agent archive before committing it, so the bytes remain readable after
  temporary Process cleanup without a second conversation-owned copy.

The archive operation uploads and verifies the immutable R2 object before a synchronous SQLite
commit records the segment and removes its hot rows. A failed upload or changed candidate leaves the
SQLite messages intact.

Process history keeps its existing lifecycle and archive policy. Conversation history and Process
activity can therefore rotate independently without conflating what the user saw with how the work
was performed.

Desktop keeps voice and hands-free controls at the right edge beneath the prompt. Reconnect feedback
appears beside the attachment actions, without reserving blank space to the right of the input controls.
The outgoing-message spinner lasts until delivery is acknowledged. Ship's activity mark follows the
active run independently of its transcript, including context preparation and reasoning before any
visible work arrives. A streaming reply takes over that feedback; a run that continues after sending
shows activity again until it ends. The model label identifies the run's selected model, not whether
the provider has started returning tokens.

Instrument resolves attachment bytes through its authenticated gateway connection. Browser clients
use ordinary image links and downloads; Desktop opens raster images in an in-app preview and saves
files to the system Downloads folder. Audio and video retain their inline players. Documents and
active formats such as HTML and SVG remain downloads rather than executable previews. A Desktop
image preview retains its own temporary URL until it closes, so navigating away from the source
message cannot invalidate an open preview; closing it or signing out releases that URL.
Older messages may link directly to a remote file. Those links open separately in the browser;
native saves apply to the attachment blobs resolved by the authenticated frontend.

## Search

Chat opens conversation search from its header action or with `Ctrl+K` from any view.
`/` in browse mode and `Ctrl/Cmd+F` in Chat remain available. People uses the same search
dialog and syscall for the selected contact conversation. Selecting a result shows the
original message and surrounding messages in the dialog, preserving the conversation position and
any draft when the dialog closes.

`conversation.search` searches canonical message text using the Conversation DO's SQLite FTS5 index.
Words are literal prefixes, combined with AND; punctuation is not a query language. Results contain
plain-text snippets, authors, dates, message IDs and sequences, newest first. Queries accept up to
256 characters and 32 words, with up to 50 results per page. `nextBeforeSequence` pages older hits.
Attachment contents and internal Process reasoning are not included.

Only messages committed after search is enabled are indexed. Existing messages remain readable
through history, with no archive backfill or indexing alarms. Each new message adds its terms and
sequence to a contentless FTS index in the same transaction as the message. Idempotent replays do not
add another index entry.

The index retains terms and positions when messages move to R2, without retaining another copy of
their text or metadata. Search resolves the returned matches from hot messages or the relevant R2
segments to produce previews; a segment containing several matches is read once per query.

Search retention uses a 6 GB pressure threshold for the entire Conversation database, including
message receipts and archive metadata. SQLite's live database size excludes reusable pages. Above
the threshold, each new message advances a bounded FTS merge or removes up to 128 oldest search
entries and advances the merge. Contentless-delete indexing permits eviction without reading old
message bodies from R2. Reclamation runs within normal message writes, with no alarms or backfill.

This is an incremental storage budget, with headroom below the 10 GB paid-plan limit, rather than a
synchronous hard ceiling: deleted postings are reclaimed as merges progress. Pruning always leaves
the incoming message searchable. Canonical messages, media, archive references and idempotency
receipts are never removed by search retention; an evicted result remains readable through history.
Those canonical records have their own storage lifetime, so this policy does not bound all
conversation metadata forever.

Ship uses the same syscall through `message search "words"`. `--with` selects an owned conversation or
Contact, `--before` pages older matches, and `--json` returns the structured result. A message sequence
can be read with `message history --with CONVERSATION --before NEXT_SEQUENCE --limit 1`.

Clients can use `conversation.history` with `afterSequence` to read forwards from a match. It cannot
be combined with `beforeSequence`. Both return messages in chronological order; `hasMore` continues
to describe earlier messages, while the conversation's `latestSequence` identifies newer messages.

## Authorization

Public conversation mutations require a direct authenticated user client. History and search also
admit that user's canonical Ship with the corresponding capabilities; other Process callers cannot
read the user's conversations. Processes cannot append user messages or recursively admit themselves.
Adapter ingress and Process message commits use private Kernel-owned paths after
the Kernel has resolved owner, route, Process, and conversation identity.

Conversation IDs are opaque. Installation identity remains the outer physical boundary for the
Kernel, Conversation Durable Object names, and R2 keys.
