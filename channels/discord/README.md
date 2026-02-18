# GSV Discord Channel

Discord bot integration for GSV Gateway.

## Discord Bot Setup

### 1. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" → Name it (e.g., "GSV Bot")
3. Note your **Application ID** (needed for invite URL)

### 2. Create Bot & Get Token

1. Go to "Bot" in the left sidebar
2. Click "Add Bot" (if not already created)
3. Under "Token", click "Reset Token" → Copy and save it securely
4. This is your `DISCORD_BOT_TOKEN`

### 3. Enable Privileged Intents (REQUIRED)

The bot needs MESSAGE_CONTENT intent to read message text:

1. Go to "Bot" → "Privileged Gateway Intents"
2. Enable **Message Content Intent** ✓
3. Optionally enable **Server Members Intent** if you need member info

Without MESSAGE_CONTENT, the bot will receive messages but `content` will be empty!

### 4. Generate Invite URL

1. Go to "OAuth2" → "URL Generator"
2. Select scopes: `bot`
3. Select permissions:
   - Send Messages
   - Attach Files
   - Read Message History  
   - View Channels
   - Add Reactions (optional)
4. Copy the generated URL and open it to invite the bot to your server

Or construct manually:
```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=101376&scope=bot
```

### 5. Configure GSV

Add your bot token as a secret:

```bash
# Local development
echo 'DISCORD_BOT_TOKEN=your-token-here' > .dev.vars

# Production (via wrangler)
wrangler secret put DISCORD_BOT_TOKEN
```

## Usage

### Start the bot
```bash
# Local
npm run dev
curl -X POST http://localhost:8787/start

# Or via Gateway RPC
gsv channel start discord
```

### Check status
```bash
curl http://localhost:8787/status
```

### Stop the bot
```bash
curl -X POST http://localhost:8787/stop
```

## Architecture

```
Discord Gateway API (wss://gateway.discord.gg)
        ↓ WebSocket
┌─────────────────────────────────────────┐
│  DiscordGateway (Durable Object)        │
│  - Maintains persistent WS connection   │
│  - Handles IDENTIFY, HEARTBEAT, RESUME  │
│  - Dispatches MESSAGE_CREATE events     │
└─────────────────────────────────────────┘
        ↓ Service Binding RPC
┌─────────────────────────────────────────┐
│  GatewayEntrypoint.channelInbound()     │
└─────────────────────────────────────────┘
        ↓ Gateway DO RPC
┌─────────────────────────────────────────┐
│  GSV Gateway                            │
│  - Routes to Session                    │
│  - Calls LLM                            │
└─────────────────────────────────────────┘
        ↓ Service Binding RPC
┌─────────────────────────────────────────┐
│  DiscordChannel (WorkerEntrypoint)      │
│  - send() → Discord REST API            │
│  - setTyping() → Discord REST API       │
└─────────────────────────────────────────┘
```

## DM vs Server Messages

| Context | peer.kind | Behavior |
|---------|-----------|----------|
| Direct Message | `"dm"` | Bot responds to all messages |
| Server Channel | `"group"` | Bot responds when mentioned (`wasMentioned: true`) |

You can configure Gateway's `dmPolicy` to control this behavior.

## Troubleshooting

### Bot connects but doesn't receive messages
- Check MESSAGE_CONTENT intent is enabled in Developer Portal
- Verify bot has "View Channel" permission in the server

### "Invalid session" errors
- Bot token may have been regenerated - update your secret
- Check for rate limiting (reconnect with exponential backoff)

### Messages not being processed
- Check Discord worker logs for RPC delivery failures
- Check Gateway logs for `channelInbound` / `channelStatusChanged` errors
