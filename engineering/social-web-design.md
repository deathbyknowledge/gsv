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
and navigation/reload protects unsent content. Requests show no remote avatars,
link previews or fetched attachments. Established messages retain safe media,
reply references and a clear human / Ship / approved-draft attribution.

“Ask my Ship” previews the exact selected messages and resources entering context.
Draft approval previews the exact recipient and content. Automatic assistance
has its own explicit scope, budget and stop control. None of these grants are
hidden inside accepting a message or saving a person.

Verification is split by the standing work agreement: CI owns automated
behavior and boundary checks; the maintainer trials the rendered UI, keyboard,
mobile and two-space flows. These design decisions are not a claim that the
entire experience is implemented or visually accepted.
