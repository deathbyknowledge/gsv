# Reviewed replies

People can adopt a committed reply from a fresh scoped helper into a private
draft. The human reviews and may edit its wording, chooses exact immutable
attachments from that reply or the helper's selected materials, and chooses the
current recipient. Saving that review does not send a message. The draft is
immutable: changed content requires a new draft and a new approval.

Kernel SQLite owns the draft, owner, source message, Process attribution,
recipient generation, content, revision and submission receipt. Drafts retain
for seven days, with at most 128 per owner, 2,048 per installation and 16 MiB of
content. Keyset pages read at most 50 records. Cleanup runs at creation and
retains expired records for one extra day. The bounded draft is a control-plane
review record; canonical committed messages still belong to Conversation.

Only a credential-authenticated human can create, inspect, approve or discard a
draft. Approval additionally requires contact.send. It claims the reviewed
revision before asynchronous delivery work; a crossed discard cannot revoke a
claimed submission. An uncertain submission can only retry that same immutable
content and stable delivery identity. The ordinary federation outbox owns media
retention, delivery, retry and contact-generation fences. A final synchronous
check denies expiry before outbox admission. Once committed, delivery survives
helper revocation and cannot be unsent.

Federation v2 carries approved-draft provenance with the source Process and
approval identity, derived by the Kernel. The model-facing contact.send arguments
cannot choose this attribution. Legacy peers cannot receive an approved draft
without v2 support. A recipient authenticates the sending space's assertion,
not independent proof of the human's physical presence.

The private helper can expire while its human still reviews a draft. That ends
agent authority; the separate exact human approval remains valid until the
draft expires or the recipient relationship changes. An expired unsubmitted
draft cannot initiate delivery. Previously submitted state remains inspectable
for its retention window. CI executes the regression sources; the two-space
human trial remains required.
