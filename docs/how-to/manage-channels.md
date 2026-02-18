# How to Manage Channels

Channels connect GSV to messaging platforms. Each channel runs as a separate Cloudflare Worker with its own Durable Object for maintaining persistent connections. The gateway communicates with channels via Service Bindings.

## Deploy channels

Channels are deployed alongside the gateway. Include them during initial deployment:

```bash
gsv deploy up --all
```

Or deploy a specific channel:

```bash
gsv deploy up -c channel-whatsapp
gsv deploy up -c channel-discord
```

Both WhatsApp and Discord channels require an always-on Durable Object. The free Cloudflare tier supports one always-on DO. Running multiple channels or multiple accounts within a channel requires a paid Workers plan.

## WhatsApp

### Connect WhatsApp

WhatsApp uses QR-code authentication via the Baileys library. The connection runs in a Durable Object that maintains the WebSocket to WhatsApp's servers.

```bash
gsv channel whatsapp login
```

This displays a QR code in your terminal. Scan it with WhatsApp on your phone (Settings > Linked Devices > Link a Device).

You can specify an account ID if you want to manage multiple WhatsApp accounts:

```bash
gsv channel whatsapp login my-second-account
```

### Check WhatsApp status

```bash
gsv channel whatsapp status
```

### Disconnect WhatsApp

Stop the connection (keeps credentials for reconnection):

```bash
gsv channel whatsapp stop
```

Log out completely (clears stored credentials):

```bash
gsv channel whatsapp logout
```

After logout, you'll need to scan the QR code again to reconnect.

### WhatsApp reconnection

The WhatsApp Durable Object automatically reconnects when the connection drops. Stored auth credentials survive DO hibernation, so the connection resumes without re-scanning the QR code unless you explicitly log out.

## Discord

### Set up a Discord bot

Before connecting, you need a Discord bot token:

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a New Application
3. Go to the **Bot** tab, click **Add Bot**, then **Reset Token** to get your token
4. Enable **MESSAGE CONTENT INTENT** in the Bot tab
5. Invite the bot to your server using:
   ```
   https://discord.com/oauth2/authorize?client_id=<APP_ID>&permissions=101376&scope=bot
   ```

Pass the bot token during deployment:

```bash
gsv deploy up -c channel-discord --discord-bot-token "$DISCORD_BOT_TOKEN"
```

### Start the Discord bot

```bash
gsv channel discord start
```

The Discord channel maintains a Gateway WebSocket connection to Discord's API, handling heartbeats and message dispatch through the Durable Object.

### Check Discord status

```bash
gsv channel discord status
```

### Stop the Discord bot

```bash
gsv channel discord stop
```

## Configure channel access control

Each channel has a DM policy that controls who can message the agent.

### Pairing mode (default for WhatsApp)

Unknown senders trigger a pairing request. You approve them via CLI:

```bash
# List pending pairing requests
gsv pair list

# Approve a sender
gsv pair approve whatsapp "+1234567890"

# Reject a sender
gsv pair reject whatsapp "+1234567890"
```

### Allowlist mode

Only specific senders can message:

```bash
gsv config set channels.whatsapp.dmPolicy "allowlist"
gsv config set channels.whatsapp.allowFrom '["+1234567890", "+0987654321"]'
```

### Open mode (default for Discord)

Anyone can message. Use with caution:

```bash
gsv config set channels.discord.dmPolicy "open"
```

## Monitor channel status

List all connected channel accounts:

```bash
gsv channel list
```

## How inbound messages route to sessions

1. A message arrives at the channel worker (e.g., WhatsApp DO receives a message)
2. The channel DO calls `env.GATEWAY.channelInbound()` via Service Binding RPC
3. The gateway checks the sender against the channel's DM policy
4. If allowed, the gateway resolves the agent ID (using agent bindings if configured)
5. The gateway builds a session key based on `dmScope` and identity links
6. The message is routed to the appropriate Session DO
7. The Session DO runs the agent loop (LLM + tools)
8. The response is sent back through the channel via `channel.send()`

## Troubleshooting

**WhatsApp QR code not appearing:** Check that the channel-whatsapp worker is deployed (`gsv deploy status -c channel-whatsapp`) and that you have network connectivity to the gateway.

**WhatsApp disconnects frequently:** The DO may be hibernating and failing to resume. Check `gsv channel whatsapp status` for the connection state. Try `gsv channel whatsapp logout` then `gsv channel whatsapp login` for a fresh session.

**Discord bot not responding:** Verify the bot has the MESSAGE CONTENT INTENT enabled and is invited to the server with correct permissions. Check `gsv channel discord status`.

**Messages from unknown senders are blocked:** Check your DM policy. In `pairing` mode, senders need explicit approval. In `allowlist` mode, add the sender's ID to the allowlist. Run `gsv pair list` to see pending requests.
