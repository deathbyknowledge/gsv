# Contact people on other GSVs

**People** holds conversations with people on other GSV spaces. Open it with `p`.
Inbox shows conversations and unread messages; Requests holds first messages from
new people; Contacts is your private address book. Search inside a conversation
with **search** or `Ctrl/Cmd+F`.

## Start a conversation

Choose **new conversation** and enter someone's public profile address. Review
the profile, choose the display name they will see, and send a first message.
They can accept or decline it. Acceptance keeps that first message in the same
conversation and enables further messages and attachments.

Alternatively, choose **use a private invitation** to create or accept a one-use
contact code. These invitations are separate from
[inviting an account into your space](/how-to/invite-people).

Your profile starts private. In **Settings → Profile**, save a draft, review it
and explicitly publish it. A profile can accept message requests, require a private
invitation, or close new contact. Saving later edits does not change the public
page until you publish again. Unpublishing removes the page; existing contacts and
conversations remain. People who already viewed it may retain copies.

## Decide who handles it

Accepting a contact or receiving a message does not start Ship. To delegate the
conversation, enable **Let Ship handle this** in its Details. Ship can read and
reply using its ordinary permissions and approval rules. Disable the same control
to take it back. Messages distinguish the person from their Ship.

Work for a particular task is separate from that standing preference. When Ship
sends with `message send --to contact:ID --responsibility R12Y_ID`, replies continue
the existing responsibility. They do not enable permanent handling of that contact.
An exact reply identifies its task; an unthreaded reply continues work only when
one active responsibility awaits that contact. Resolving or cancelling the work
ends that association. The receiving person independently chooses who handles
their side.

## Private controls

Read position, archive, saved contacts, aliases and mute are private to your space.
New messages bring an archived conversation back unless muted. Muting also suppresses
tab attention; it does not revoke Ship's existing assignment.

Blocking ends the connection, withdraws its attachment grants and refuses new
messages and requests from that identity. Unblocking permits a new connection;
it does not restore the old one. Delivered messages remain in history. Both
conversation Details and a message request's controls offer block and unblock.
**Blocked people** keeps these controls available even after an old request expires.

## Work requests

The person offering work can cancel an unaccepted offer. The person receiving it can accept or reject it, then start, complete or cancel accepted work. GSV shows only the actions available to your side.

An update takes effect locally before the other GSV confirms it. **Awaiting confirmation** keeps the request open, including a completion or cancellation. **Update not confirmed** means delivery failed; it does not claim the other person accepted that outcome. Older records can show **Confirmation unavailable**.

## Delivery

Queued messages retry automatically with the same identity. A recoverable failure can be resumed through `contact.delivery.retry` by the signed-in person or their Ship. Retrying resends the stored message; it does not add another message to the conversation. Permanent refusals, revoked contacts and messages older than seven days cannot be retried.

See the [contact commands](/reference/cli-commands) and [contact syscalls](/reference/syscalls) for delivery inspection and automation.
