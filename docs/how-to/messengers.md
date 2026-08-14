# Connect a messenger

Once a messenger is connected, you can talk to GSV from it just like you do on the desktop — anything you can ask GSV, you can ask from anywhere.

Connecting a bot or phone account and linking your messenger identity are
separate steps. If you leave setup after the connection succeeds but before
entering the authorization code, do not create another account. Return to
**Messengers** and use **Link messenger identity**. Message the connected bot
or account again if the previous one-time code has expired.

## WhatsApp

WhatsApp connects as a linked device. You need a second WhatsApp account and
phone number, but not necessarily a second phone. The official WhatsApp app can
keep two accounts on one compatible Android or iOS phone; the second account
still needs its own number and SIM, multi-SIM, or eSIM. See Meta's
[multi-account setup](https://about.fb.com/news/2023/10/multiple-accounts-on-whatsapp/)
and [iOS announcement](https://about.fb.com/news/2026/03/whatsapp-new-features-simplify-storage-switch-accounts/).

1. If the worker is not installed, deploy it with `gsv infra deploy -c channel-whatsapp`. A normal full deployment already includes it.
2. In GSV, open **Messengers**, choose **WhatsApp**, and give this connection a stable account ID such as `personal`.
3. Start pairing. Display GSV's QR code on a computer or another screen so the phone can scan it.
4. On the phone that owns the second WhatsApp account, open **Settings → Linked Devices → Link a Device** and scan the code.
5. Wait for GSV to show the account as authenticated. Pairing connects the GSV number, but does not yet identify the person who will message it.
6. Switch to the personal WhatsApp account that should represent you and send a new direct message to the WhatsApp number paired with GSV. GSV replies with a one-time link code.
7. Enter the code in GSV's **Link user** step. The code links that WhatsApp sender to the GSV user currently signed in. It expires after ten minutes.
8. Send another message to begin chatting. The first message requested the code and is not forwarded to an agent.

The QR payload is a short-lived pairing credential. Treat it like a password:
do not paste it into chat, save it, log it, or share a screenshot. GSV renders
the code locally and should never print the underlying payload when rendering
fails.

You can also pair from a UTF-8 terminal:

```bash
gsv adapter connect --adapter whatsapp --account-id personal
gsv adapter status --adapter whatsapp --account-id personal
```

Rerun the normal connect command if an unscanned QR expires. Use
`--config-json '{"force":true}'` only to discard a broken or logged-out session
and perform a fresh link; it clears the saved WhatsApp authentication and needs
a new QR scan.

### Connection lifecycle

The adapter keeps an outbound WhatsApp WebSocket in its account Durable Object.
An active outbound connection now prevents eviction, but Cloudflare limits that
[keepalive effect to 15 minutes per connection](https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/).
The connection can continue after 15 minutes, but it no longer keeps the object
resident. GSV therefore schedules an account alarm every 30 seconds. Each alarm
is an incoming Durable Object event inside Cloudflare's minimum 70-second idle
eviction window, so the object remains resident without periodically opening a
second WhatsApp session. Baileys pings WhatsApp separately and reconnects only
when the provider transport is unhealthy. An explicit **Log out** or a forced
re-pair is different and removes the linked-device credentials.

WhatsApp uses the unofficial open-source Baileys client rather than an official
WhatsApp Business API integration. WhatsApp protocol changes or linked-device
policy can therefore cause temporary breakage. Keep GSV updated and avoid
running another client that repeatedly replaces the same linked session.

### Troubleshooting WhatsApp

- **The QR expired:** run Connect again to obtain a fresh code. Never reuse a saved QR payload.
- **The phone says linked but GSV is still waiting:** check `gsv adapter status --adapter whatsapp --account-id personal`, wait for one reconnect cycle, then retry normal Connect.
- **The account is paired but no link code arrives:** pairing only connects the GSV number. Confirm adapter status is connected and authenticated, then send a fresh direct message from the personal sender account to the paired GSV number. Do not send it from the paired account itself or in a group.
- **The direct message gets no reply:** verify that both the Gateway and `channel-whatsapp` workers are deployed and their service bindings target each other. Inspect both workers' live logs: the inbound message reaches the Gateway before the adapter sends the link-code reply.
- **GSV rejects the link code:** codes are single-use and expire after ten minutes. Send another new direct message, then enter the new code while signed in as the GSV user you want to link. CLI users can run `gsv auth link CODE`.
- **The code was accepted but the original message got no agent answer:** send another message. The message that generated the code is used only for identity linking and is not replayed to an agent.
- **The account was logged out or replaced:** remove stale linked-device entries in WhatsApp, then use the confirmed force re-pair flow once.
- **It reconnects repeatedly while idle:** this is not routine maintenance. Inspect the adapter's structured `socket_closed` logs and provider status code.
- **Several accounts do not stay connected on Workers Free:** the limiting resource is Durable Object duration, not the roughly 2,880 residency alarms per day. Treat one continuously connected WhatsApp account as the Free-plan baseline and use Workers Paid for more always-resident accounts.

The Workers Free plan supports the SQLite-backed Durable Objects used by GSV;
Containers are not required. One continuously resident 128 MB account consumes
about 11,060 GB-s of the current 13,000 GB-s daily Durable Object allowance.
That is an operating estimate, not a capacity guarantee: other active Durable
Objects consume the same allowance. Leave headroom for the rest of GSV and
check Cloudflare's current
[Durable Objects pricing and limits](https://developers.cloudflare.com/durable-objects/platform/pricing/)
before adding continuously connected accounts.

## Telegram

1. In GSV, open **Messengers** and click **Connect messenger.**
2. Open [@BotFather](https://t.me/botfather) in Telegram (on your laptop or your phone) and press **Start.**
3. Send `/newbot`. Pick a display name (e.g. `ham`), then a username ending in `bot` (e.g. `ham_bot`).
4. BotFather replies with a **token** that looks like `123456789:QWErtyUIOP`. Back in GSV, click **Next**, then **Next**, and paste the token.
5. Open your new bot's profile — BotFather links it in that last message — and press **Start.** It returns an **access code**; paste that into GSV.
6. Connected. Send `/help` in Telegram to see what it can do.

Try it from your phone, away from your desk: *What's on my Mac's clipboard?*

### Commands

```
/where                          show PERSONAL HOME or the selected WORK SESSION
/home                           return this direct message to personal home
```

Ask your personal intelligence when you want a direct line to one piece of its
work. It selects the work process internally, confirms what will receive the
next message, and remains your personal intelligence. The current answer still
comes from personal home; later messages use the visibly labeled work session
until you enter `/home`. Returning home also gives the personal intelligence a
small process event naming the work process, without copying its transcript.

When a direct-message approval is pending, copy one of the full commands shown
in that prompt. Each includes a unique `hil[...]` token; do not omit it or reuse
a command from an older prompt.

## Discord

1. In GSV, open **Messengers** and click **Connect messenger → Discord.**
2. Go to the [Discord Developer Portal](https://discord.com/developers/applications), click **New Application**, and name your bot.
3. In the left sidebar, go to **Bot**. Under **Token**, click **Reset Token**, copy it, and save it — this is your bot token.
4. On the same page, under **Privileged Gateway Intents**, enable **Message Content Intent**. Without this the bot receives messages but cannot read them.
5. Go to **OAuth2 → URL Generator**. Select the `bot` scope, then select these permissions: **Send Messages**, **Attach Files**, **Read Message History**, **View Channels**. Copy the generated URL, open it in your browser, and invite the bot to your server.
6. Back in GSV, paste the bot token to finish connecting.

In a server channel the bot only responds when mentioned. In a DM it responds to every message.

## See also

- [Connect Devices](/how-to/connect-devices) — give GSV access to your machines
- [Get Started](/get-started/)
