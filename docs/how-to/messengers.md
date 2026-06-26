# Connect a messenger

Once a messenger is connected, you can talk to GSV from it just like you do on the desktop — anything you can ask GSV, you can ask from anywhere.

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
/list               show available agents and active processes
/where              show where this chat is routed
/use personal       route back to your personal conversation
/use <process-id>   route this chat to an active process
/use <agent-name>   start and route this chat to an agent
```

When an approval is pending, reply `approve`, `deny`, or `approve always`.

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
