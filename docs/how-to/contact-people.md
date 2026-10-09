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

Choose **connect**, choose who should handle new messages, then **create invitation
link** and share it wherever you already talk. It connects one person and lasts seven days; you can cancel it before it is
accepted. In managed spaces, the link opens the existing Accounts space chooser.
The recipient chooses a listed space or enters its address, signs in if needed,
and chooses who should handle their new messages before accepting the invitation. Entering an address also works for people
using another operator or a space they do not own. Other deployments open the
space-address form directly.
Neither person needs to publish a profile. Acceptance opens the conversation.

If someone gives you a link or an older contact code, choose **connect → I have an
invitation** to paste it. These invitations are separate from
[inviting an account into your space](/how-to/invite-people).

You can also ask Ship to create an invitation, or give it someone's invitation
link to accept. Ship asks who should handle new messages unless you already told
it, then completes the connection with that choice. It can also change the choice
later when you ask. This works in your ordinary Ship conversation, including
messaging apps; opening People is optional.

Choose **connect → use a profile address** to find a saved contact by name or enter
someone's public profile address. Review the profile and your prefilled display
name, choose who handles new messages, then send a first message.
They make their own handling choice when accepting, or can decline it. Acceptance keeps that first message in the same
conversation, opens it directly, and enables further messages and attachments.

Your profile starts private. In **People → Me** at the bottom of the left rail,
save a draft, review it and explicitly publish it. A profile can accept message
requests, require a private invitation, or close new contact. Saving later edits
does not change the public page until you publish again. Unpublishing removes the
page; existing contacts and conversations remain. People who already viewed it
may retain copies. After you
save an alias, **Me** shows that alias, your display name and your new-conversation
setting.

## Decide who handles it

When connecting in People, both people explicitly choose **I’ll handle them** or
**Let Ship handle them** for their own side. Neither option is preselected. The
choice stays with the invitation or request, even if acceptance happens later.
Existing contacts keep their settings. Ship-led invitations use the same explicit
choice; creating or accepting one does not silently choose automatic handling.

**Automatically handle new messages**, beside the person's name, changes this
choice. When on, Ship can respond using its ordinary permissions and approval
rules. Accepting or enabling the setting does not wake Ship or replay existing
messages; the next incoming message starts handling. Turning it off ends that
standing assignment. Replies to tasks you assign separately can still resume
those tasks until they finish. Messages distinguish the person from their Ship.

For a particular task, choose **ask Ship** in the conversation. This opens an
editable request in your ordinary Ship chat. Review it and send it when ready.
It does not turn on automatic replies for that person. A first-use example can
prefill a more specific request, such as finding a time for dinner.

The **people** line above the Ship prompt keeps unread conversations and incoming
requests within reach, including after reload or reconnect. New messages update
the line without opening a panel or moving your place in the Ship conversation.
Select a person's name to read and reply in a compact panel. A **PERSON** or
**GSV** badge identifies who wrote the latest message. **Open conversation** takes
you to the full history in People; selecting a connection request opens it there.
Conversation previews label outgoing messages **You** or **Your Ship**, so they
cannot be mistaken for a new reply from the other person.

Closing the panel keeps an unfinished reply for this session, marked **draft** on
the person's name. Sending threads the reply to the message it answers and clears
that answered activity; a newer arrival still waits. A dot beside **people** in
the main navigation also marks unread activity. Muted, blocked, ended and archived
conversations stay quiet; an unfinished draft remains reachable.

Work for a particular task is separate from that standing preference. When Ship
sends with `message send --to contact:ID --responsibility R12Y_ID`, replies continue
the existing responsibility. They do not enable permanent handling of that contact.
An exact reply identifies its task; an unthreaded reply continues work only when
one active responsibility awaits that contact. Resolving or cancelling the work
ends that association. The receiving person independently chooses who handles
their side.

A message’s **reply** action quotes that message in the same conversation and keeps
its exact reference, including on the first incoming message before you have sent
anything back. Reply and successful delivery information appear on hover or
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
