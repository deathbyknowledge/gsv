# People in Instrument

People owns deliberate communication: an inbox, first-contact decisions and a
private address book. At a glance it answers who sent something, which items
need a decision, and whether a message or connection is still pending. The main
actions are open, reply, request a conversation, accept and decline. Settings
continues to own the public profile; Fleet owns places and running work; Zen
owns speaking directly to Ship. Contextual links connect these surfaces.

The shared Instrument header adds People at `/people`. Its main layout is a
list and a generous conversation pane. On narrow screens, selection opens the
detail with a visible back control and restores the list on return. Both panes
use the existing typefaces, color tokens and text actions. A focused compose or
acceptance form may use a primary block button. No dashboard tiles, public
activity stream, relationship score or automatic people discovery.

Contact management has one home in People. Fleet no longer duplicates its list,
composer or invitations. A selected conversation distinguishes ordinary Messages
from Work requests; these are separate from first-contact Message requests.

The report flow starts from selected message copies, or the first message of a
request. The reporter chooses an active support/moderation contact, optionally
checks exact attachments, adds a note and reviews the full outgoing message.
Reporting uses ordinary authorized contact delivery, with stable retry identity;
there is no implicit operator endpoint or new report database. Only deliberately
checked files are forwarded, without their locally derived transcription. The
recipient's conversation retains delivery state and the committed report.

- **Inbox** shows established conversations, private unread position, the latest
  message and honest delivery state. Archive and mute have separate controls.
- **Message requests** separates received requests from sent ones. A request
  opens its original message and verified sender identity. Accept explains that
  it opens this conversation; it does not save a contact or enable Ship.
  Decline stays private. Block has an explicit explanation and confirmation.
  Preparing, received, connecting, failed and expired states have distinct copy.
- **Contacts** is the saved address book, with local filtering and an individual
  person's details, identity, relationship controls and deliberately shared
  context. Unsaving does not revoke a conversation.

Public profiles have a “Message from your GSV” handoff. The visitor chooses their
own space, then reviews the recipient and sends from its authenticated UI. The
handoff carries only the public profile address. Neither visiting a profile nor
following a compose link sends a message. The sender explicitly chooses the
display name shared with this person; sign-in names never silently become
published identity.

Compose follows resolve → review → write. A changed profile requires another
review. Text remains available after errors, retry uses the original intent,
and navigation/reload protects unsent content. A resolved request profile can
show its published image through the local gateway; the browser does not fetch
another space directly. Requests show no link previews or fetched attachments.
Established messages retain safe media,
reply references and a clear human / Ship / approved-draft attribution.

There is no social helper or “Ask my Ship” surface. A contact's private
relationship settings include one explicit “Let Ship receive new messages”
choice. It controls whether an incoming message creates Ship attention; it does
not grant reply authority. Ship may then use its ordinary scoped Process tools,
and any outgoing message keeps its human or Ship provenance visible.

Opening scoped work in Zen keeps a persistent access summary and the same
process identity. Its prompt accepts only the inputs granted to that scope.
Revoked, expired, disconnected or exhausted work remains readable with its
composer disabled. Scope and contact signals refresh that state across clients.
A broader task starts with a fresh explicit grant.

Verification is split by the standing work agreement: CI owns automated
behavior and boundary checks; the maintainer trials the rendered UI, keyboard,
mobile and two-space flows. These design decisions are not a claim that the
entire experience is implemented or visually accepted.

Catch up is a finite, private list of message alerts and incoming message
requests in People. The shared header shows both kinds of pending attention, and
the Requests tab shows its incoming request count. Notify is immediate; Digest
gathers a conversation's messages for 24 hours before it becomes ready. Each row
opens a conversation or opens the exact request for review. Dismissing a
conversation alert does not mark the thread read; viewing a request does not
decide it. Declining a request is private and does not notify the sender. The UI
explains queued digest timing and keeps unread conversation state separate. No
browser notification permission or generated summary is needed.

Work requests expose the immutable offer and two short participant statement
lists. A stop request, cancellation confirmation, result report, dispute and
acknowledgement have distinct language. Choosing an action opens a short review
with an optional note; a changed request requires rereview, while an uncertain
submission keeps its exact retry intent. Fleet remains the home for private
execution details and responsibilities.

Shared with you sits beside a person's details and a message request. It reads
only locally cached statements from chosen sources, with named attribution,
selected quotes, expiry and receipt freshness. The person inspector also owns
per-kind subscription review and an explicit view of what that one person
shares. Your shared context lists owned publications and incoming connection
consent decisions in separate bounded pages. Publishing and consent each show
the exact wording, audience and expiry before committing. Selected-message
sharing exposes at most three reviewed excerpts, with no implicit file grants.
Delivery receipts and exact retries distinguish a saved proposal from a
received proposal and from the person's eventual consent decision.

Delegated work stays visible in its ordinary Process surface. Contact message
history and work requests remain separate, and an incoming message never
creates work or a draft review by itself.
