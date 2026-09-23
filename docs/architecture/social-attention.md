# Private message attention

Messages remain in their Conversation regardless of notification policy. The
Kernel keeps at most one pending attention row for each contact Conversation,
containing a bounded committed-message preview and the latest covered sequence.
This is a private list of conversations to revisit, not an activity feed or a
model-generated summary. It is separate from Ship attention: each contact has
an explicit `shipAttention` preference, disabled by default. When enabled for
an active, unmuted contact, an incoming human or explicitly approved message
also creates one deduplicated `federation.message` responsibility for Ship and
may wake the personal controller. Process-produced messages remain ordinary
conversation records without waking Ship, which prevents Ship-to-Ship reply
loops. The responsibility contains bounded metadata and points Ship at the
Conversation; it never includes remote text as instructions and it never grants
`contact.send`.

Notify makes the row immediately available. Digest makes the row available
24 hours after the first pending message from that person; later messages join
that batch without moving its deadline. Quiet and mute create no human
attention. Mute also suppresses Ship attention; turning on `shipAttention`
does not override a mute.
The existing Kernel scheduler announces due digests in batches of at most 100
conversations. Its durable state and the original deadline survive eviction.
Clients read the same ready rows after reconnect, even if they missed the signal.

Migration v066 stores attention beside the Conversation directory in Kernel
SQLite. A monotonic processed sequence prevents replayed ingress from recreating
a dismissed alert. Admission updates that checkpoint, the preview and the private
inbox projection in one transaction. The upgrade initializes the checkpoint from
committed history, so existing messages do not become a new backlog of alerts.

Read position and attention dismissal are independent. Dismissal binds the exact
displayed sequence; a newer incoming message survives an older dismissal. Reading
through the covered sequence or archiving clears the alert. Changing notification
policy or mute clears queued alerts; unmuting does not resurrect them. Every
projection also checks current generation, active communication, mute, policy,
archive and read state. Stale rows cannot contribute to counts or digest signals.

The private `conversation.attention.list` and `.dismiss` syscalls require a
signed-in human. The list has owner-indexed keyset pages and bounded previews;
counts use Kernel metadata without loading Conversation histories. The invalidation
signal additionally requires the list capability. No read or dismissal is sent
to the other participant.

People exposes the list as Catch up alongside incoming message requests. Requests
are read from the existing owned approach list, with a total independent of page
size; they do not acquire a second alert record. The shared header counts ready
conversation alerts plus active incoming requests. The Requests tab also shows
that incoming count. An approach change refreshes request pages and the summary,
including after reconnect. Merely viewing a request does not dismiss its decision.

Catch up opens a request for review or a conversation for reading. Only a
conversation alert can be dismissed there; accepting, declining or blocking a
request resolves its separate decision. The separate unread cursor advances only
when messages are actually visible in the reading pane.

An ordinary contact message and a work request remain different protocol
objects. A message can create the optional `federation.message` Ship
responsibility described above; a structured request uses `federation.request`
and its own participant-owned lifecycle. Ship must never infer a work contract
from message wording. Outgoing message provenance makes the speaker explicit:
`human` means the owner sent it, `process` means Ship sent it, and `approved`
means the owner approved an exact process-produced send. Submission mechanics
and speaker identity are audited separately.
