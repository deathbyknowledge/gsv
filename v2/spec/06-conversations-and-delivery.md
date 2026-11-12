# 06 · Conversations and delivery

How messages are stored, how inbound messages find their conversation, where
outbound messages go, and how messengers, contacts and mail fit the same model.

## Conversations are folders

A conversation is an indexed folder and a message is a file `[D 11-10]`. The
author is the revision author, set by the gate. Search is the folder index.
Attachments are copies in the folder (rows pointing at the same hash). Agents
read chats with ordinary file tools. A busy group gets its own Volume.

```text
/home/<person>/chats/<conversation id>/
  2026-11-12T10-41-07Z-<message id>.json   one message per file, created if absent by name
  files/<name>                              attachments as row copies
```

Paths and the file format are `[NEW]`:

```ts
type MessageFile = {
  id: string;                    // from the sender's op id or the provider's message id
  author: { person: OwnerId } | { agent: AccountId; pid: Pid } | { contact: OwnerId } | { sender: SenderRef };
  text: string;
  attach?: FileRef[];
  choices?: Choice[];
  replyTo?: string;
  origin: { surface: "app" | "messenger" | "mail" | "contact"; ref?: string };
  delivery?: DeliveryChoice;     // stored once with the message, reused by retries
};
```

The owner DO keeps an index row per conversation: folder, profile label (the
profile's conversation name, e.g. `personal`), handler (a profile agent or
none), `follow`, `per`, members and bindings `[D 11-12]`. Clients find the
person's followed conversation by a generic call, not by a Ship label: it is
returned by `owner.view.get` `[NEW]`.

| Conversation | Count | Handler | Source |
| --- | --- | --- | --- |
| Personal (`follow: true`) | one per person owner | the profile's long-lived agent | profile `[D 11-12]` |
| Group (`per: "group"`) | one per messenger group | the profile's agent | profile `[D 11-12]` |
| Contact | one per contact | none | runtime default `[D 11-12]` |
| Work session | one per opened session | the chosen process, visibly labelled | `[1.0]` |

## Message flow

```mermaid
sequenceDiagram
  participant C as Client
  participant O as Owner DO
  participant V as Volume DO (chat folder)
  participant P as Process DO
  C->>O: fs.write message (op id)
  O->>V: create-if-absent message file
  V-->>O: revision
  O->>O: append conversation.message (key = message id), pick deliveries
  O-->>C: ok; other clients get {feed, head}
  O->>P: deliver(events)
  P->>P: run, Send
  P->>V: create-if-absent reply file (ticket)
  V->>O: head + new rows for the watched folder
  O->>O: append conversation.message, choose delivery once
  O-->>C: ping on the chosen endpoint, silent sync elsewhere
```

- A reply is committed to the folder before delivery starts, so delivery
  survives the Process dying after commit `[D 11-09]`.
- The Volume DO pushes heads for folders the owner DO watches, with the new
  rows inline up to 64 KiB, so a reply reaches the owner DO in one hop `[NEW]`.
- On wake, the owner DO reconciles each watched folder's feed against its
  `conversation.message` keys, so a crash between the file write and the append
  loses nothing `[NEW]`.

## Inbound: bindings

All inbound routing is one mechanism: bindings in the owner DO from an external
surface to a conversation `[D 11-12]`.

- Pairing a messenger binds the person's DMs to their followed conversation.
- A new messenger group creates a new `per: "group"` conversation and binds the
  group to it.
- 1.0's direct line to a helper and the `/ship`, `/where`, `/list` commands
  are gone; the Ship relays instead. `/help` stays `[D 11-12]`.

## Addressing

The handler gets every message from the conversation's counterpart (the person
in a personal conversation). In a crowd (groups, shared conversations) it gets
only mentions and replies to it `[D 11-12]`.

- Messenger groups drop unaddressed messages; they are never stored `[1.0]`.
- In-app shared conversations store every message, and when the agent is
  addressed it gets the messages since it last spoke as context `[D 11-12]`.
- Only an addressed message cancels a running tool `[D 11-12]`.

## Outbound: the delivery choice

Chosen once per message when the owner DO takes delivery, stored with the
message, reused by its retries. Drafts stay where they began `[D 11-12]`.

| Conversation | Goes to |
| --- | --- |
| Followed (`follow: true`) | the person's last active client (5.5 minutes; activity only refreshes, never selects), else their private messenger |
| `per: "group"` | its bound group |
| Others | open clients only |

The conversation is the truth and delivery is a copy: every open client of every
member syncs from the folder `[D 11-12]`. A ping is the one attention signal per
message per person (tab or window attention, a sound, later an OS
notification), sent only to the chosen endpoint; other clients update silently
`[D 11-12]`.

Sending to anyone else is explicit (`channel.*.send`, `message send --to`) and
is `channel.send` on the destination, asking by default when it reaches people
other than the owner `[D 11-12]`.

Delivery attempts follow the schedule in [04](04-owner-event-log.md): 10 ms,
then 1, 2, 4, 8, 16, 30, 30, 30, 30 s; ambiguous attempts are never retried; the
adapter link generation is checked at each send; final failure appends
`delivery.failed` to the writer, with no fallback `[D 11-12]` `[1.0]`.

## Notifications and approvals

- Notifications are per-person settings: per event kind, mentions and
  approvals, each `off`, `app` or `app + messenger`. They are delivered by the
  same choice; repeats collapse for 10 minutes; push notifications come later
  `[D 11-12]`.
- Notification text is a template rendered at delivery: each event kind's
  catalog entry carries an i18n key and placeholders from its payload, rendered
  in the person's language. Values from outside (a stranger's mail subject) are
  plain text, escaped per surface and length-capped. A message's own
  notification is its text `[D 11-12]`.
- Approvals go privately to whoever answers, by the same choice, never into a
  group `[D 11-12]`.

## Messengers

- The operator's shared accounts (Telegram, WhatsApp, Discord, Slack) pair by
  code, as in 1.0 `[1.0]`. Pairing is people-only: the Ship may walk the person
  through it, and a card naming the account behind the code completes only with
  a signed-in person's tap `[D 11-11]`.
- An owner may connect their own bot instead (needed for self-hosting): a
  connection on the owner. Paste a Telegram token; the runtime checks it, sets
  the webhook with a per-connection secret and stores the token sealed. One
  webhook endpoint per platform; the adapter Worker finds the connection and
  hands the message to that owner's DO. Outbound sends pass the connection's
  credential per call over the internal binding, never in events or logs
  `[D 11-12]`.
- Link status changes are `channel.created` and `channel.updated` events with
  the messenger type and status `[D 11-12]`.

## Contacts

Ship-to-Ship between people stays inside one deployment as cross-owner events
`[D 11-11]`. Contacts are keyed by owner id; the deployment sets the sender; no
DIDs, keys or tokens are involved.

- `channel.invite.*` creates and accepts contact invitations;
  `channel.request.*` handles message requests from non-contacts;
  `channel.task.*` handles tasks a contact asks of the Ship `[D 11-11]`.
- `channel.contact.send` writes the sender's copy into their contact
  conversation and forwards a `conversation.message` event to the recipient
  owner, which writes it into its own contact conversation `[NEW]`.
- Contact conversations have no handler. Pairing and first-message acceptance
  create no agent commitment; a person may hand a contact message to the Ship
  as a responsibility. Duplicates and receipts never admit agent work `[1.0]`.
- Contact authority and first-contact admission belong to the runtime's channel
  kind, not the profile `[D 11-11]`.

## Mail

One mailbox per person owner, at their handle (`<handle>@<domain>`). The
address is shown only when the deployment has mail `[D 11-12]`.

| Call | Rule |
| --- | --- |
| M1 | Mail is files: `mail/inbox/<id>/` holds `raw.eml`, `message.md` and extracted attachments; `mail/sent/<id>/` holds the full sent copy; the mail folder is indexed; delete goes to the bin `[D 11-12]` |
| M2 | Threads come from `In-Reply-To` and `References`; replies carry the full chain `[D 11-12]` |
| M3 | Intake records SPF, DKIM and DMARC. Only aligned mail matches a contact. All mail still reaches the Ship, marked verified or not `[D 11-12]` |
| M4 | The mail service only carries mail (receive, dedupe, limits, send). Storage, threads and the summary live in the owner DO; the summary counts in the owner's AI quota `[D 11-12]` |
| M5 | The runtime builds raw MIME and sends from the owner DO's due-work table (no Queues). 1.0's send rules stay: an unknown outcome is never resent, `From` is pinned, sending asks by default. Bounces link to their message and append `delivery.failed` `[D 11-12]` |
| M6 | The shell's `mail` command is unchanged; CodeMode gets `channel.mail.send` plus file operations `[D 11-12]` |

## Invariants

- **CONV-1** A message reaches delivery only after its file is committed.
- **CONV-2** A message's delivery choice is made once and never changes across retries.
- **CONV-3** Every open client of every member converges on the folder's content without a ping.
- **CONV-4** An unaddressed group message never starts or cancels agent work.
- **CONV-5** An approval card never appears in a group conversation.
- **CONV-6** A messenger credential never appears in an event, log, trace or ledger row.
- **CONV-7** A contact message or receipt never creates agent work by itself.
- **CONV-8** Unverified mail never matches a contact.

## Failure cases

| Case | Behaviour |
| --- | --- |
| The chosen client disconnects before delivery | The choice stands; the message syncs when any client reconnects. |
| Messenger delivery keeps failing | `delivery.failed` to the writer after the last attempt; the message stays in the folder. |
| Messenger link generation changed since the choice | The send is refused and recorded as failed; no other surface is tried. |
| Recipient owner refuses a contact message | `delivery.failed` to the sending process. |
| Inbound mail exceeds a mail limit | The service refuses it at intake and counts the refusal. |

## Latency budget `[NEW]`

| Path | p50 | p99 |
| --- | --- | --- |
| Person sends → message committed and acked to the client | 30 ms | 120 ms |
| Agent reply committed → visible on the chosen client | 40 ms | 150 ms |
| Messenger webhook → event appended | 50 ms | 200 ms |

## Tests

- Kill the Process right after its reply commits: the reply is still delivered.
- Crash the owner DO between file write and append: reconcile on wake appends exactly once.
- Follow choice: active client, idle client after 5.5 minutes, no client; activity never selects a client.
- Group addressing: unaddressed messages dropped, addressed ones cancel a running tool.
- Notifications: templates render in Spanish and English; a hostile mail subject is escaped and capped.
- Mail: thread reconstruction from headers; DMARC-failing mail from a contact's address doesn't match the contact.
- Own Telegram bot: token never appears in any stored row except the sealed connection.
