# Contact people on other GSVs

**People** holds conversations with people on other GSV spaces. Open it with `p`.
It opens your conversations and unread messages. **Requests**, above the list, opens
first messages from new people; its count shows the loaded active requests, with
`+` when more remain. **contacts**, beside the heading, opens your private address
book. Both have a **← conversations** action to return to your previous conversation.
Search inside a conversation with **search** or `Ctrl/Cmd+F`. Open **details** for
the private name, mute and connection controls. **Save contact** adds someone to Contacts without
changing their permissions or how Ship handles the conversation.

On your first visit, try an example: make plans, plan a trip, or work together.
Choose **try this with someone** to connect. The example remains available when
your conversation opens, so you can turn it into a request to Ship.

## Start a conversation

Choose **connect → create invitation link** and share the link wherever you already
talk. It connects one person and lasts seven days; you can cancel it before it is
accepted. In managed spaces, the link opens the existing Accounts space chooser.
The recipient selects their own space, signs in if needed, and explicitly accepts
the invitation. Other deployments ask for the recipient's space address.
Neither person needs to publish a profile. Acceptance opens the conversation.

If someone gives you a link or an older contact code, choose **connect → I have an
invitation** to paste it. These invitations are separate from
[inviting an account into your space](/how-to/invite-people).

Choose **connect → use a profile address** to find a saved contact by name or enter
someone's public profile address. Review the profile and your prefilled display
name, then send a first message.
They can accept or decline it. Acceptance keeps that first message in the same
conversation, opens it directly, and enables further messages and attachments.

Your profile starts private. In **Settings → Profile**, save a draft, review it
and explicitly publish it. A profile can accept message requests, require a private
invitation, or close new contact. Saving later edits does not change the public
page until you publish again. Unpublishing removes the page; existing contacts and
conversations remain. People who already viewed it may retain copies.

## Decide who handles it

Accepting a contact does not start Ship. Enable **Ship replies** beside the person's
name to let Ship respond to new incoming messages using its ordinary permissions
and approval rules. Turning it on waits for the next message; it does not start work
on the existing conversation. Turn it off to stop ongoing handling. Messages
distinguish the person from their Ship.

For a particular task, choose **ask Ship** in the conversation. This opens an
editable request in your ordinary Ship chat. Review it and send it when ready.
It does not turn on automatic replies for that person. A first-use example can
prefill a more specific request, such as finding a time for dinner.

A contact message that arrives while you are in the Ship chat adds a notice under
the transcript, labelled like any sender: the person's name with a **PERSON** or
**GSV** badge for who wrote it, then the first words of their newest message.
**show message** (or **show N messages** while several wait) opens them in full
with a reply box inline; sending threads your reply to the newest one, marks the
conversation read, and leaves the notice marked **(replied)** until that contact
writes again. **go to chat** opens the
conversation in People; a reply you started under the notice stays there, in the
Ship chat, until you send or clear it. These inline notices are for this session.
The **people** strip above the prompt also shows unread conversations and message
requests from earlier, including after a reload or reconnect. Select a person or
request to open it in People. A dot beside **people** in the main navigation stays
visible while unread activity waits. Muted, blocked, ended and archived
conversations do not attract attention there.

Work for a particular task is separate from that standing preference. When Ship
sends with `message send --to contact:ID --responsibility R12Y_ID`, replies continue
the existing responsibility. They do not enable permanent handling of that contact.
An exact reply identifies its task; an unthreaded reply continues work only when
one active responsibility awaits that contact. Resolving or cancelling the work
ends that association. The receiving person independently chooses who handles
their side.

A message’s **reply** action quotes that message in the same conversation and keeps
its exact reference. Reply and successful delivery information appear on hover or
keyboard focus; touch screens keep the actions visible. Delivery problems remain
visible until resolved.

## Private controls

Read position, archive, saved contacts, aliases and mute are private to your space.
New messages bring an archived conversation back unless muted. Muting also suppresses
tab attention and the Ship chat's new-message line; it does not revoke Ship's existing
assignment.

Blocking ends the connection, withdraws its attachment grants and refuses new
messages and requests from that identity. Unblocking permits a new connection;
it does not restore the old one. Delivered messages remain in history. Both
conversation Details and a message request's controls offer block and unblock.
**Blocked people** keeps these controls available even after an old request expires.

## Work requests

Open **details → Work requests** in the conversation to inspect shared work.

The person offering work can cancel an unaccepted offer. The person receiving it can accept or reject it, then start, complete or cancel accepted work. GSV shows only the actions available to your side.

An update takes effect locally before the other GSV confirms it. **Awaiting confirmation** keeps the request open, including a completion or cancellation. **Update not confirmed** means delivery failed; it does not claim the other person accepted that outcome. Older records can show **Confirmation unavailable**.

## Delivery

Queued messages retry automatically with the same identity. A recoverable failure can be resumed through `contact.delivery.retry` by the signed-in person or their Ship. Retrying resends the stored message; it does not add another message to the conversation. Permanent refusals, revoked contacts and messages older than seven days cannot be retried.

See the [contact commands](/reference/cli-commands) and [contact syscalls](/reference/syscalls) for delivery inspection and automation.
