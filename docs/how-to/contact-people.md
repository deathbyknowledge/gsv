# Contact people on other Ships

**People** holds conversations with people on other Ships. Open it with `p`.
It opens your conversations and unread messages. **Requests**, above the list, opens
first messages from new people; its count shows the loaded active requests, with
`+` when more remain. **contacts**, beside the heading, opens your private address
book. Both have a **← conversations** action to return to the conversation list.
Browser **Back** and **Forward** also restore the People list, selected conversation,
requests and profile. These destinations have their own URLs; unsent drafts stay
in the current session while you move between them.
Search inside a conversation with **search** or `Ctrl/Cmd+F`. Open **details** for
the private name, mute and connection controls. **Save contact** adds someone to Contacts without
changing their permissions or how Ship handles the conversation.

On your first visit, try an example: make plans, plan a trip, or work together.
Choose **try this with someone** to connect. The example remains available when
your conversation opens, so you can turn it into a request to Ship.

## Start a conversation

Choose **connect**, choose who should handle new messages, then **create invitation
link**. Share it wherever you already talk. The same link works for someone new
to Ship or someone who already has a Ship. It connects one person and lasts seven
days; you can cancel it before acceptance.

On a managed deployment, the link opens a centered invitation showing who invited you.
Choose **Continue**. Existing users select their Ship; new users verify their
email and create one. The contact invitation stays with them through signup and
setup. In their Ship, they choose who handles new messages and accept the connection.
Each person's choice affects only their own incoming messages. Neither person
needs to publish a profile.

The recipient can also enter a Ship address, including one hosted by another
operator. This remains available if the browser cannot load or save signup state.
Deployments without a signup service open that address form directly.
If someone shares a link or a contact code, **I have an invitation** lets you
paste it in People.

Ship can create or accept these same invitations when asked, after you choose
who handles new messages. In Shell, use `contact invite create --handling manual`
or `--handling ship`. A private invitation needs neither a published profile nor
an existing contact. If you know the person's email address, Ship can send the
returned URL with `mail send`, using the ordinary mail approval policy. Use the
recipient's known email address, including their managed Ship mailbox; a custom
Ship website address does not establish its email address.

Emailing the link leaves acceptance to the recipient. `mail status DELIVERY_ID`
tracks the email, while `contact invite list --all` shows whether the invitation was
accepted. There are no signup-place reservations or registration codes. Ordinary
contact expiry, cancellation and rate limits still apply.

Choose **connect → use a profile address** to find a saved contact by name or enter
a handle such as `esteve` or `@esteve`, or someone's public profile address.
Handles resolve on the operator’s configured primary domain. Accepted legacy domains also display as handles; overlapping domains use the most specific match. Full addresses still reach other operators.
In Shell, `contact find @esteve` (or a full address) shows the same public profile.
This lookup only finds published profiles. An unavailable profile does not mean
the Ship is missing and does not prevent sharing a private invitation.
Chat’s **+ → find a person** uses the same lookup and lets you mention the profile
in your draft without contacting them. Review the profile and your prefilled display
name, choose who handles new messages, then send a first message.
They make their own handling choice when accepting, or can decline it. Acceptance keeps that first message in the same
conversation, opens it directly, and enables further messages and attachments.

Your profile starts private. Choose **your profile** at the bottom of People,
save a draft, review it and explicitly publish it. Your public address is
`https://YOUR-SPACE/profile`. Existing published
profile links still work. Drafts remain when you return to a conversation. A profile can accept message requests, require a private
invitation, or close new contact. Saving later edits does not change the public
page until you publish again. Unpublishing removes the page; existing contacts and
conversations remain. People who already viewed it may retain copies.
The published page uses Ship's cursor icon in the browser tab, the same pale block on a dark square as the app.
On phones, the profile editor keeps its title and back arrow above the scrolling
form. The same lavender edge used in conversations appears only while text crosses
that scroll boundary.

## Decide who handles it

When connecting in People, both people explicitly choose **I’ll handle them** or
**Let Ship handle them** for their own side. Neither option is preselected. The
choice stays with the invitation or request, even if acceptance happens later.
Existing contacts keep their settings. Ship-led invitations use the same explicit
choice; creating or accepting one does not silently choose automatic handling.

**Automatically handle new messages**, in the conversation's **details**, changes
this choice. On phones, **more** opens **ask Ship**, **search** and **details**;
the back arrow returns to the full-height conversation list. The short handling
status beneath the person's name also opens details when space permits.
The composer uses Chat's growing prompt and selection styling. Its **+** opens the
file picker for attachments, and **send** appears beside the prompt when there is
text or an attachment to send. Ship's target and request controls remain in Chat.
When on, Ship can respond using its ordinary permissions and approval
rules. Accepting or enabling the setting does not wake Ship or replay existing
messages; the next incoming message starts handling. Turning it off ends that
standing assignment. Replies to tasks you assign separately can still resume
those tasks until they finish. Messages distinguish the person from their Ship.
Ship receives each message it handles with its photos and files, as it does a
messenger message, and keeps them as its own copies.

For a particular task, choose **ask Ship** in the conversation. This opens an
editable request in your ordinary Ship chat. Review it and send it when ready.
It does not turn on automatic replies for that person. A first-use example can
prefill a more specific request, such as finding a time for dinner.

The activity line above your Ship’s prompt keeps unread conversations and incoming
requests beside ongoing plans, including after reload or reconnect. New messages update
the line without opening a panel or moving your place in your Ship conversation.
Select a person's name to read and reply in a compact panel. A **PERSON** or
**Ship** badge identifies who wrote the latest message. **Open conversation** takes
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

Read position, archive, saved contacts, aliases and mute are private to your Ship.
New messages bring an archived conversation back unless muted. Muting also suppresses
tab attention and your Ship chat's new-message line; it does not revoke Ship's existing
assignment.

Blocking ends the connection, withdraws its attachment grants and refuses new
messages and requests from that identity. Unblocking permits a new connection;
it does not restore the old one. Delivered messages remain in history. Both
conversation Details and a message request's controls offer block and unblock.
**Blocked people** keeps these controls available even after an old request expires.

## Work requests

Open **details → Work requests** in the conversation to inspect shared work.

The person offering work can cancel an unaccepted offer. The person receiving it can accept or reject it, then start, complete or cancel accepted work. Ship shows only the actions available to your side.

An update takes effect locally before the other Ship confirms it. **Awaiting confirmation** keeps the request open, including a completion or cancellation. **Update not confirmed** means delivery failed; it does not claim the other person accepted that outcome. Older records can show **Confirmation unavailable**.

## Delivery

Queued messages retry automatically with the same identity. A recoverable failure can be resumed through `contact.delivery.retry` by the signed-in person or their Ship. Retrying resends the stored message; it does not add another message to the conversation. Permanent refusals, revoked contacts and messages older than seven days cannot be retried.

See the [contact commands](/reference/cli-commands) and [contact syscalls](/reference/syscalls) for delivery inspection and automation.
