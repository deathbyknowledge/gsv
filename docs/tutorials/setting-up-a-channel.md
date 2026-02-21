# Connecting a Channel

In this tutorial, we will connect a messaging platform to your GSV agent so you can chat with it from WhatsApp or Discord. By the end, you will be able to send a message on your chosen platform and receive a response from your agent.

This tutorial assumes you have already completed [Getting Started with GSV](getting-started.md) and have a deployed gateway.

## Choose your channel

GSV supports two messaging channels. Pick the one you want to set up:

- **[WhatsApp](#whatsapp)** -- uses QR code authentication, connects to your personal WhatsApp account
- **[Discord](#discord)** -- uses a bot token, runs as a Discord bot in your server

---

## WhatsApp

### 1. Deploy the WhatsApp channel worker

If you did not deploy the WhatsApp channel during your initial setup, deploy it now:

```bash
gsv deploy up -c channel-whatsapp
```

This downloads the WhatsApp channel bundle and deploys it as a separate Cloudflare Worker with a Service Binding to your gateway.

When it finishes, you should see:

```
Deploy complete.
```

### 2. Log in with your WhatsApp account

The WhatsApp channel uses the Baileys library to connect to WhatsApp's servers. Authentication works through a QR code -- the same flow as WhatsApp Web.

Run:

```bash
gsv channel whatsapp login
```

A QR code will appear in your terminal. On your phone:

1. Open WhatsApp
2. Go to **Settings > Linked Devices**
3. Tap **Link a Device**
4. Scan the QR code in your terminal

After scanning, wait a few seconds. You should see output confirming the connection:

```
WhatsApp connected
```

Check the status to confirm:

```bash
gsv channel whatsapp status
```

You should see `connected: true` and `authenticated: true` in the output.

### 3. Send a test message

From a different phone or WhatsApp account, send a message to the WhatsApp number you just linked. Alternatively, you can message yourself (some WhatsApp versions allow this).

The first message from a new sender triggers a **pairing request**. GSV does not reply to unknown senders until you approve them. Check for pending requests:

```bash
gsv pair list
```

You should see the sender listed. Approve them:

```bash
gsv pair approve whatsapp "+1234567890"
```

Replace `+1234567890` with the actual sender ID shown in the pair list.

Now send another message from that number. The agent will respond through WhatsApp.

You can verify the session was created:

```bash
gsv session list
```

Look for a session key like `agent:main:whatsapp:dm:1234567890@s.whatsapp.net`.

**You now have WhatsApp connected.** Skip ahead to [What we accomplished](#what-we-accomplished).

---

## Discord

### 1. Create a Discord bot

Go to the [Discord Developer Portal](https://discord.com/developers/applications):

1. Click **New Application** and give it a name (e.g., "GSV")
2. Go to the **Bot** tab
3. Click **Reset Token** and copy the bot token -- you will need it in the next step
4. Under **Privileged Gateway Intents**, enable **MESSAGE CONTENT INTENT**

### 2. Invite the bot to your server

Still in the Developer Portal, note the **Application ID** from the General Information tab. Construct the invite URL by replacing `<APP_ID>` below:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&permissions=101376&scope=bot
```

Open that URL in your browser, select your server, and authorize the bot. You should see the bot appear in your server's member list (it will be offline for now).

### 3. Deploy the Discord channel worker

Deploy the channel with your bot token:

```bash
gsv deploy up -c channel-discord --discord-bot-token "your-bot-token-here"
```

This deploys the Discord channel worker and uploads the bot token as a Cloudflare Worker secret. When it finishes, you should see:

```
Deploy complete.
```

### 4. Start the Discord bot

Tell the gateway to start the Discord connection:

```bash
gsv channel discord start
```

Check the status:

```bash
gsv channel discord status
```

You should see `connected: true` in the output. The bot should now appear as online in your Discord server.

### 5. Send a test message

In your Discord server, send a message that mentions the bot:

```
@GSV Hello, are you there?
```

The agent should reply in the channel. Direct messages to the bot also work.

As with WhatsApp, new senders may require pairing approval. Check with:

```bash
gsv pair list
```

And approve if needed:

```bash
gsv pair approve discord "your-discord-user-id"
```

Verify the session:

```bash
gsv session list
```

You should see a Discord session in the list.

---

## What we accomplished

You now have a messaging channel connected to your GSV agent:

- The channel worker runs as a separate Cloudflare Worker alongside your gateway
- Inbound messages are routed to the gateway, which creates a session and runs the agent loop
- The agent's responses are sent back through the channel

A few things to note:

- Each channel requires an always-on Durable Object. The Cloudflare free tier supports one always-on DO, so running multiple channels may require a paid plan.
- You can connect both WhatsApp and Discord to the same gateway -- the agent maintains separate sessions for each conversation.
- Channel sessions are independent from your CLI session. The agent has separate message history for each.

From here, you can:

- [Write a custom skill](writing-a-skill.md) to extend what the agent can do
- Manage sessions with `gsv session list`, `gsv session preview <key>`, and `gsv session reset <key>`
- Configure channel policies with `gsv config set` (e.g., allowlists, DM policies)
