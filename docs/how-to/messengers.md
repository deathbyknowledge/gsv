# Connect a messenger

Once a messenger is connected, you can talk to Ship from it just like you do on the desktop — anything you can ask Ship, you can ask from anywhere.

Messengers are extensible. This page documents the messengers bundled with the
current release; it is not a complete list of messaging apps Ship can connect.

Your deployment operator enables the Telegram, Slack, Discord, and WhatsApp
apps offered in **Messengers**. You connect your account on that messenger with
a short-lived code.
You do not need to create a bot or paste its token into your Ship.

When Ship needs your approval, the messenger shows what it wants to do. A
request to publish on the [open network](/architecture/open-network) always
names the handle and full address it publishes as, such as
`@alice (alice.ship.space)`, whatever else Ship wrote. A request to install a
crontab likewise shows the file and its jobs.

## Ask Ship to connect

Ask Ship to connect the messenger you want. It gets the current connection
instructions from that messenger and shares the link or bot name.
Follow those instructions, then paste the code back into your conversation.
Ship redeems it for your account and tells you when the connection succeeds.
No visit to Settings is needed. If the code expires, request a new one.
To also use that messenger for password recovery, connect it directly in Settings.

Only share a code from your own messenger account. If it is already connected
to another Ship, redeeming the code moves that connection to this Ship.
Send another message in the messenger after connecting to start talking to Ship.

You can also connect through **Settings → Messengers**, using the steps below.
WhatsApp appears first, followed by Telegram. Slack and Discord carry a small
**Coming soon** label and their Connect and Reconnect controls are disabled,
even when the deployment enables pairing. Existing links can still be inspected
or disconnected. The Slack and Discord instructions below describe the adapter
flows used through Ship; they are not currently available in Settings.

## Telegram

1. In Ship, open **Messengers → Telegram** and use the link to open the official
   Ship bot.
2. Send the bot any private message. It replies with a short-lived code.
3. Enter that code back in Ship. Ship shows the Telegram display name, handle,
   and numeric ID that requested it.
4. Confirm only if that is your Telegram account. The code alone cannot choose
   an installation or user; the signed-in Ship session supplies both.
5. Send another message in Telegram. It reaches the same Ship conversation
   you use in Ship, without selecting a helper.

If your Telegram account was connected to another Ship, requesting or inspecting
a code does not interrupt it. The route moves only after confirmation succeeds.
Use **Disconnect** on the connected account to revoke it.

Try it from your phone, away from your desk: *What's on my Mac's clipboard?*

### Commands

```
/where                          show SHIP or the selected HELPER
/ship                           return this direct message to Ship
```

Ask Ship when you want a direct line to one of its helpers. It selects the
helper internally, confirms what will receive the next message, and remains
your Ship. The current answer still comes from Ship; later messages use the
visibly labeled helper until you enter `/ship`. Returning to Ship also gives it
a small event naming the helper, without copying its transcript.

When a direct-message approval is pending, copy one of the full commands shown
in that prompt. Each includes a unique `hil[...]` token; do not omit it or reuse
a command from an older prompt.

## Slack

1. Ask Ship for the Slack connection instructions and open its installation link.
2. Approve the official Ship app for the intended Slack workspace. If another
   member already installed it there, you can continue with that installation.
3. Mention `@GSV` in a channel, or send the app a direct message. Ship sends a
   short-lived code to your Slack direct messages.
4. Enter the code back in Ship. Check the Slack user ID shown before confirming.
5. Confirm only if it is your Slack account. The code itself cannot select an
   installation or local user; the signed-in Ship session supplies both.
6. Mention `@GSV` again to start a conversation. In a channel, replies remain
   in the originating thread. The first mention only requested the code and is
   not replayed to Ship.

The app installation belongs to the Slack workspace, while the connection
belongs to one person. If Alice and Bob use the same workspace, each connects
separately and each author's mentions keep routing to their own Ship. Making
Alice and Bob Contacts does not change that default Slack route. Either Ship
can still contact the other explicitly through Ship's normal federation model.

Public channel and thread responses identify whose Ship produced them.
Direct-message responses omit that prefix.
Reconnecting a Slack account moves future messages only after confirmation
succeeds; delayed messages and replies from the old connection are rejected.

Slack supports incoming files and Ship resource attachments in addressed messages.
With personal Slack authorization, the connected workspace can also appear as a
read-only filesystem and command target. The operator-owned app performs writes;
your personal OAuth token determines read visibility. See the Slack messenger's
README in the source tree for configuration and target details.

## Discord

1. Open **Messengers → Discord** in the Ship you want to connect.
2. Use the operator application's install link if the bot is not already in the
   intended server, or open a direct message with it.
3. Mention the bot with `connect`, or message it privately. It sends a private code.
4. Enter the code in Ship, check the Discord account shown, and confirm it.
5. Send another DM or server mention to start a conversation.

Installing the bot does not connect everyone in a server. Each person connects
their own account, and a server route is separate from a direct-message route. Two
people in the same server can use different Ships. Replies remain bound to the
confirmed author and observed destination.

## WhatsApp

Ship uses one operator-owned WhatsApp Business number on the WhatsApp Business
Platform. You message that number from your own WhatsApp account.

1. In Ship, open **Settings → Messengers → WhatsApp**. It shows the Ship number
   and a link that opens WhatsApp on it.
2. Send the number any message. It replies with instructions and a separate
   code-only message you can copy. The code expires in 10 minutes. If your
   number is already connected to another Ship, send `/link` to get a new code.
3. Enter the code back in Ship. Ship shows the WhatsApp profile name and the
   masked number that requested it.
4. Confirm only if that is your WhatsApp number. The code alone cannot choose a
   Ship or user; your signed-in session supplies both.
5. Send another message. It reaches the same Ship conversation you use in Ship.

You can send text, photos, documents, voice notes, videos, and locations. Ship
replies with text and attachments, and a long reply arrives as several
messages, one per prose paragraph. Headings stay with the following block;
code blocks, lists, tables and quotations stay together. Approval
prompts arrive with **Allow once**, **Always allow** and **Block** buttons; the
decision comes back as a reply quoting the prompt. **Always allow** adds the
same rule as in the app, shown in **Settings → Permissions**.

While Ship works on a message you sent from WhatsApp, it reacts to that message
with 👀 and removes the reaction when it replies, asks for approval or stops.
The typing indicator appears only just before a reply arrives. Work Ship starts
for another reason, such as a contact's message, a schedule or a message from
the web app, adds no 👀 to your chat.
Reacting to one of Ship's messages, or removing a reaction, sends Ship nothing
and gets no reply.

Markdown document uploads keep their `.md` filename and original contents;
the WhatsApp messenger uploads them as plain text because Meta does not accept
the Markdown MIME type.

WhatsApp accepts a free-form message from Ship only within 24 hours of your last
message to the number. After that, Ship uses an approved template to send the
message, or a preview if it is too long. The full message remains in your Ship
conversation. Open Ship to read it, or reply in WhatsApp to ask Ship about it.
The **Show me** button sends an ordinary reply to Ship. Messages are not queued
for automatic delivery when you return.

Approval notifications outside the window ask you to review the request in
Ship. Attachments require an open WhatsApp window or another authorized
destination.

The operator must configure the matching Meta-approved `gsv_message` template
before out-of-window messages can be sent. It uses one body parameter and a
quick-reply button labelled **Show me**. `WHATSAPP_TEMPLATE_NAME` and
`WHATSAPP_TEMPLATE_LANGUAGE` select the template; an empty name disables it.
Meta determines its category and bills each template accordingly. See the
WhatsApp messenger README's "Message templates" section for the exact contract.

Availability depends on the operator's Meta account and the current terms for
this use of the WhatsApp Business Platform. Ask your operator whether the
service is offered for your number.

Meta restricts WhatsApp Business messaging across the borders of Brazil (+55)
and Indonesia (+62). A Ship number registered elsewhere cannot deliver the
code to numbers in either country, and a number registered in one of
them cannot reach the other. The WhatsApp page in **Settings → Messengers**
names the countries the Ship number cannot reach, and Ship says so when you
ask it to connect, offering Telegram, Discord, Slack, email, or the Ship app
instead. The operator sets `WHATSAPP_UNREACHABLE_CALLING_CODES` when Meta's
record for the account differs from the number's country, or empties it once
Meta has unlocked cross-border messaging.

The earlier linked-device messenger, which connected by scanning a QR code, is
no longer bundled, and its connections do not carry over.

## Disconnect or switch Ships {#disconnect-or-change-a-space}

Use **Disconnect** on the connected account to revoke its route. To move an
account, request a new code and confirm it from the destination Ship. Issuing
or inspecting a code leaves the old route active; confirmation changes its
generation. Delayed messages from the old route cannot cross into the new one.

## See also

- [Connect Devices](/how-to/connect-devices) — give Ship access to your computers
- [Get Started](/get-started/)
