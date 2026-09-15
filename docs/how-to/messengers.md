# Connect a messenger

Once a messenger is connected, you can talk to GSV from it just like you do on the desktop — anything you can ask GSV, you can ask from anywhere.

GSV adapters are extensible. This page documents the messenger implementations
bundled with the current release; it is not a complete list of transports an
adapter can implement.

Your deployment operator enables the Telegram, Slack, Discord, and WhatsApp
apps offered in **Messengers**. You link your human identity to a space by
inspecting and confirming a short-lived code while signed in. You do not need
to create a bot or paste its token into the space. If a code expires, message
the app again.

## Telegram

1. In GSV, open **Messengers → Telegram** and use the link to open the official
   GSV bot.
2. Send the bot any private message. It replies with a short-lived pairing
   code.
3. Enter that code back in GSV. GSV shows the Telegram display name, handle,
   and numeric identity that requested it.
4. Confirm only if that is your Telegram identity. The code alone cannot choose
   an installation or user; the signed-in GSV session supplies both.
5. Send another message in Telegram. It reaches the same Ship conversation
   you use in GSV, without selecting a process.

If the Telegram identity was linked to another GSV, requesting or inspecting a
code does not interrupt it. The route moves only after confirmation succeeds.
Use **Disconnect** on the linked identity to revoke it.

Try it from your phone, away from your desk: *What's on my Mac's clipboard?*

### Commands

```
/where                          show SHIP or the selected WORK SESSION
/ship                           return this direct message to Ship
```

Ask your personal intelligence when you want a direct line to one piece of its
work. It selects the work process internally, confirms what will receive the
next message, and remains your personal intelligence. The current answer still
comes from Ship; later messages use the visibly labeled work session
until you enter `/ship`. Returning to Ship also gives the personal intelligence a
small process event naming the work process, without copying its transcript.

When a direct-message approval is pending, copy one of the full commands shown
in that prompt. Each includes a unique `hil[...]` token; do not omit it or reuse
a command from an older prompt.

## Slack

1. In GSV, open **Messengers → Slack** and choose **Install GSV in Slack**.
2. Approve the official GSV app for the intended Slack workspace. If another
   member already installed it there, you can continue with that installation.
3. Mention `@GSV` in a channel, or send the app a direct message. GSV sends a
   short-lived pairing code to your Slack direct messages.
4. Enter the code back in GSV. Check the Slack user ID shown before confirming.
5. Confirm only if it is your Slack identity. The code itself cannot select an
   installation or local user; the signed-in GSV session supplies both.
6. Mention `@GSV` again to start a conversation. In a channel, replies remain
   in the originating thread. The first mention only requested pairing and is
   not replayed to the agent.

The app installation belongs to the Slack workspace, while the pairing belongs
to one human author. If Alice and Bob use the same workspace, each pairs
separately and each author's mentions keep routing to their own GSV. Making
Alice and Bob Contacts does not change that default Slack route. A linked GSV
can still contact the other explicitly through GSV's normal federation model.

Public channel and thread responses identify whose GSV produced them, for
example **From @Alice's GSV:**. Direct-message responses omit that prefix.
Relinking a Slack identity moves future messages only after confirmation
succeeds; delayed messages and replies from the old link are rejected.

Slack supports incoming files and GSV resource attachments in addressed messages.
With personal Slack authorization, the paired workspace can also appear as a
read-only filesystem and command target. The operator-owned app performs writes;
your personal OAuth token determines read visibility. See the Slack adapter
README in the source tree for configuration and target details.

## Discord

1. Open **Messengers → Discord** in the space you want to link.
2. Use the operator application's install link if the bot is not already in the
   intended server, or open a direct message with it.
3. Mention the bot with `pair`, or message it privately. It sends a private code.
4. Enter the code in GSV, inspect the Discord identity, and confirm it.
5. Send another DM or server mention to start a conversation.

Installing the bot does not link everyone in a server. Each person pairs their
own identity, and a server route is separate from a direct-message route. Two
people in the same server can use different spaces. Replies remain bound to the
confirmed author and observed destination.

## WhatsApp

GSV uses one operator-owned WhatsApp Business number on the WhatsApp Business
Platform. You message that number from your own WhatsApp account.

1. In GSV, open **Settings → Messengers → WhatsApp**. It shows the GSV number
   and a link that opens WhatsApp on it.
2. Send the number any message. It replies with a short-lived pairing code. If
   your number is already connected to another GSV, send `/link` to get a new
   code.
3. Enter the code back in GSV. GSV shows the WhatsApp profile name and the
   masked number that requested it.
4. Confirm only if that is your WhatsApp number. The code alone cannot choose a
   space or user; the signed-in GSV session supplies both.
5. Send another message. It reaches the same Ship conversation you use in GSV.

You can send text, photos, documents, voice notes, videos, and locations. GSV
replies with text and attachments, and approval prompts arrive with reply
buttons; the decision comes back as a reply quoting the prompt.

WhatsApp accepts a free-form message from GSV only within 24 hours of your last
message to the number. If Ship has something for you after that, GSV cannot
deliver it to WhatsApp until you message the number again. Message templates,
which Meta requires for later delivery, are not part of this release.

Meta currently restricts general-purpose assistants on the WhatsApp Business
Platform to numbers with European Economic Area or Brazilian country codes, so
availability is not worldwide. Ask your operator whether your number is
eligible.

The earlier linked-device adapter, which paired by scanning a QR code, is no
longer bundled, and its pairings do not carry over.

## Disconnect or change a space

Use **Disconnect** on the linked identity to revoke its route. To move an
identity, request a new code and confirm it from the destination space. Issuing
or inspecting a code leaves the old route active; confirmation changes its
generation. Delayed messages from the old route cannot cross into the new one.

## See also

- [Connect Devices](/how-to/connect-devices) — give GSV access to your machines
- [Get Started](/get-started/)
