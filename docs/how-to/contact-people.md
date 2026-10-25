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
activation. In their Ship, they choose who handles new messages and accept the connection.
Each person's choice affects only their own incoming messages. Neither person
needs to publish a profile.

The recipient can also enter their handle or address, including a Ship hosted by another
operator. This remains available if the browser cannot load or save signup state.
Deployments without a signup service open that address form directly.
If someone shares a link or a contact code, **I have an invitation** lets you
paste it in People.

Ship can create or accept these same invitations when asked, after you choose
who handles new messages. The built-in `contacts` skill covers inviting people,
accepting links, messaging and coordinating work; load it with `skills show contacts`.
In Shell, use `contact invite create --handling manual`
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
In Shell, `contact find @esteve` (or a full address) shows the same public profile,
and `contact connect @esteve --message TEXT --handling manual|ship` sends the same
first message request. Telling Ship "add @esteve" is enough: Ship resolves the
handle, asks you to approve sending it (an `approach.create` rule in the
[approval policy](../reference/configuration.md#tool-approval-policy) can skip the question),
and Esteve decides whether to accept. Profiles are public by default, so a handle normally resolves.
An unavailable profile does not establish whether the Ship exists: the handle may
be mistyped, the Ship elsewhere, or the profile private. It does not prevent
sharing a private invitation.
Chat’s **+ → find a person** uses the same lookup and lets you mention the profile
in your draft without contacting them. Review the profile and your prefilled display
name, choose who handles new messages, then send a first message.
They make their own handling choice when accepting, or can decline it. Acceptance keeps that first message in the same
conversation, opens it directly, and enables further messages and attachments.

A new Ship's profile is public on the open network from your first sign-in, named
by your handle and open to message requests, so people can add you by handle. Choose
your handle at the bottom of People to see your profile as others will: a **public**
or **private** label, your picture, your handle with a button that copies your
profile address, your bio, and who can start a conversation. An empty bio shows
"Space cowboy." with a **complete bio** link. While the profile is public, a note
there says who can see it and how to make it private, until you choose **got it**.
Choose **edit** to change it. **choose picture** takes a PNG, JPEG or WebP image,
which Ship crops to a square of at most 512 pixels; like the rest of the profile,
it becomes public when you publish. On a private profile the main
button is **publish**, which makes it public; on a public one it is **save**, which
updates the public page. **save as draft** keeps changes private, shown as
**unpublished changes**, and leaves the public page as it is. The note under the
buttons says which applies. Who can see my profile? describes the live page. The profile can be open to message requests from
anyone, or limited to people you invite.
Your public address is `https://YOUR-SPACE/profile`, and older `/@name` profile
links open it. Drafts remain when you return to a conversation. The
public page shows your picture, your handle, your bio, and either a form where visitors enter
their own handle to message you from their Ship, or a note that message requests
are restricted. Its Ship wordmark links to the operator's site. The page asks
search engines not to list it. Other Ships and open-network apps read the same
profile from your Ship's public record. Unpublishing removes the page and the
record and keeps the profile private until you publish again;
existing contacts and conversations remain. People who already viewed it may
retain copies. A Ship whose owner already saved, published or unpublished a profile
keeps it exactly as it was; only a Ship with no saved profile gets the public default.
If your operator takes down your profile, its picture, something else your Ship
published or your whole Ship on the open network, your handle at the bottom of
People reads **taken down**, and your profile lists each takedown with the
reason your operator gave. A profile that is down is labelled **taken down**
too. People on the open network can't see what is down until your operator
restores it. While your whole Ship is down, neither you nor your Ship can
publish or message your contacts: a message or message request you send fails
at once and says why. Messages from your contacts still arrive.
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
When on, Ship follows the conversation, replies when appropriate within your
preferences, and brings important updates or decisions to you. Your choice gives
Ship standing permission for appropriate replies without asking you to approve
each one; its ordinary capabilities and tool approvals still apply.
Accepting or enabling the setting does not wake Ship or replay existing
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
messages and requests from that person. Unblocking permits a new connection;
it does not restore the old one. Delivered messages remain in history. Both
conversation Details and a message request's controls offer block and unblock.
**Blocked people** keeps these controls available even after an old request expires.

## Report a message request {#report-a-message-request}

If a message request from someone you don't know is spam, abuse, or someone
pretending to be someone else, open it in People and choose **report**. Pick
what's wrong with it and choose **send report**. The report goes to the
operator who runs your Ship, and it declines the request. The sender isn't told.

The report always says who sent the request, by their address on the open
network (their DID and handle), what you picked, and when the request arrived.
Their name and message go only if you tick **Include their name and message**,
which starts unticked. **Also block them** blocks the sender as well. Your
operator keeps the report, with whatever it carries, until your Ship is deleted.

You can report a request once, any time until you accept it, and up to 20
requests a day. Afterwards the request says when you reported it. Your operator
can dismiss the report or, when the sender's Ship runs on the same service,
take its account down. Only you can report: Ship doesn't read the requests you
receive, so it points you to **report** in People.

## Work requests

Open **details → Work requests** in the conversation to inspect shared work.

The person offering work can cancel an unaccepted offer. The person receiving it can accept or reject it, then start, complete or cancel accepted work. Ship shows only the actions available to your side.

An update takes effect locally before the other Ship confirms it. **Awaiting confirmation** keeps the request open, including a completion or cancellation. **Update not confirmed** means delivery failed; it does not claim the other person accepted that outcome. Older records can show **Confirmation unavailable**.

## Contacts from before the open network

Contacts from before the open network keep their conversations and messages. A
contact that ended with the move to the open network, such as one whose Ship is
on another operator's deployment, stays ended, and its conversation is kept. To
keep talking, send them a new invitation or a message request. Invitation links
from before the open network no longer work, so create a new one.

## Delivery

Queued messages retry automatically with the same identity. A recoverable failure can be resumed through `contact.delivery.retry` by the signed-in person or their Ship. Retrying resends the stored message; it does not add another message to the conversation. Permanent refusals, revoked contacts and messages older than seven days cannot be retried.

A contact ends on its own when the other person's Ship is gone for good: their
space was deleted, or reset so that their address now reaches a new Ship. Your
Ship notices when a message to them fails, or when you open your conversation
with them. Opening never waits for the check, and each contact is checked at
most once an hour. The conversation stays, marked ended, and messages still
waiting fail. To keep talking, send them a new invitation or a message request.
A slow or unreachable Ship never ends a contact; its messages keep retrying.

See the [contact commands](/reference/cli-commands) and [contact syscalls](/reference/syscalls) for delivery inspection and automation.
