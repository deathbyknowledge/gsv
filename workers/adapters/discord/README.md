# GSV Discord Adapter

Discord bot integration for GSV Gateway.

## Operator application and human pairing

The shared deployment uses `wrangler.shared.jsonc` and the `SharedDiscordChannel`
service entrypoint. The operator sets `DISCORD_APPLICATION_ID` and the
`DISCORD_BOT_TOKEN` secret at deployment time. A minute cron starts the single
`DiscordApplication` provider connection; opening the pairing flow also starts it.
The application token is read from the binding and is never stored in peer state.

A person installs the bot in a Discord server, mentions it with `pair`, or sends
it a direct message. The bot sends a private pairing code. In **your GSV →
Messengers → Discord**, that person inspects the identity and confirms the link.
Server installation itself does not link anyone or select a space. Two people in
the same server may link different spaces. A person's server route and direct
message route are distinct; each route has one active space and local account.

The shared application receives direct messages and messages that mention the bot
(including replies to it), using the non-privileged Guilds, Guild Messages, and
Direct Messages intents. It does not request Message Content. The install link
requests View Channels, Send Messages, Attach Files, and Read Message History.
The adapter advertises that typing activity is unavailable on this shared path.
See Discord's [Gateway documentation](https://docs.discord.com/developers/events/gateway)
for the message-content exceptions for direct messages and bot mentions.

`DiscordPeer` durably owns pairing, delivery, ingress, and its generation-fenced
route. Delayed messages and media replies recheck the route before crossing the
Gateway or provider boundary. A relink invalidates the previous generation and
cleans the old Kernel projection. Approvals remain human-facing and include a
link to the person's GSV; they do not wake a parent model.

The shared Worker exposes only `/health` over HTTP. Provider ingress arrives on
the operator's authenticated Gateway connection. Service bindings carry the
existing attenuated Discord adapter grant. No public route accepts a token,
installation id, or local account id.

The existing `DiscordGateway` namespace and the following legacy deployment
instructions are retained until the explicit W7 cutover. Select the shared
entrypoint in the deployment graph; deploying this source does not migrate old
namespace records or establish historical erasure evidence.

## Legacy Discord Bot Setup

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

### Connect the bot
```bash
gsv adapter connect --adapter discord --account-id default
```

### Check status
```bash
gsv adapter status --adapter discord --account-id default
```

### Disconnect the bot
```bash
gsv adapter disconnect --adapter discord --account-id default
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
│  - Persists pending inbound events       │
│  - Retries them with its existing alarm  │
└─────────────────────────────────────────┘
        ↓ Service Binding RPC
┌─────────────────────────────────────────┐
│  Gateway serviceFrame(adapter.inbound) │
└─────────────────────────────────────────┘
        ↓ Gateway DO RPC
┌─────────────────────────────────────────┐
│  GSV Gateway                            │
│  - Routes to a durable Process           │
│  - Coordinates inference                 │
└─────────────────────────────────────────┘
        ↓ Service Binding RPC
┌─────────────────────────────────────────┐
│  DiscordChannel (WorkerEntrypoint)      │
│  - adapterFrame() → Discord REST API    │
│  - adapterSetActivity() → Discord API   │
└─────────────────────────────────────────┘
```

The account Durable Object stores each compact `MESSAGE_CREATE` JSON payload
before its first Gateway RPC. It removes the record only after a terminal
Kernel disposition; transport failures and `replayed: "in_progress"` use the
existing alarm for retry, rebuilding attachment bodies on each attempt.

## DM vs Server Messages

| Context | surface.kind | Behavior |
|---------|-----------|----------|
| Direct Message | `"dm"` | Bot responds to all messages |
| Server Channel | `"group"` | Bot responds when mentioned directly or when a user replies to one of the bot's messages (`wasMentioned: true`) |

## Troubleshooting

### Bot connects but doesn't receive messages
- Check MESSAGE_CONTENT intent is enabled in Developer Portal
- Verify bot has "View Channel" permission in the server

### "Invalid session" errors
- Bot token may have been regenerated - update your secret
- Check for rate limiting (reconnect with exponential backoff)

### Messages not being processed
- Check Discord worker logs for RPC delivery failures
- Check Gateway logs for `adapter.inbound` / `adapter.state.update` errors
