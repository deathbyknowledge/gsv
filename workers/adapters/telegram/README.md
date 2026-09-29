# GSV Telegram Adapter

Telegram bot integration for GSV Gateway using the Telegram Bot API webhook flow.

GSV uses one operator-owned bot. A Telegram user messages that bot, receives a
short-lived code, and confirms the displayed identity from a direct signed-in
GSV session. The bot token stays on the adapter Worker; individual spaces never
accept or store it.

The Worker is `src/managed.ts` with `wrangler.managed.jsonc`. It keeps
one peer Durable Object per private Telegram identity and a separate short-lived
pairing object per code. Telegram can have only one active webhook per bot, so
staging and production require different BotFather bots and credentials.

## Outbound Media

- Supports outbound attachments for `image`, `video`, `audio`, and `document`.
- Accepts up to 20 attachments in one GSV reply.
- Supports media groups (albums) with 2-10 attachments.
- Compatible consecutive attachments are grouped automatically. Mixed media that
  Telegram cannot place in one album (such as a PNG and PDF), and sets larger
  than 10 items, are split into ordered deliveries.
- Attachment source can be `url` or a range in the request's top-level binary body.
- If `text` is present, it is sent once as the first delivery's caption (for
  groups, the caption is applied to the first item).

## Configuration

The platform operator configures these Worker secrets and variables:

- `TELEGRAM_BOT_TOKEN` — the platform bot token
- `TELEGRAM_WEBHOOK_SECRET` — a random Bot API webhook secret
- `TELEGRAM_BOT_USERNAME` — the public bot username shown in GSV
- `TELEGRAM_WEBHOOK_BASE_URL` — the adapter Worker’s public origin
- `TELEGRAM_ALLOWED_ACTOR_IDS` — optional comma-separated staging allowlist

The Worker accepts only `POST /webhook`. It verifies the secret header
before reading a bounded request body and rejects group, channel, and bot
messages. The platform reconciles `setWebhook` only after the Worker, its
Durable Objects, and both Gateway service bindings are healthy.

## Usage

1. Send any private message to the official GSV bot.
2. Copy the 12-character code from its reply.
3. Open **GSV → Messengers → Telegram**, enter the code, inspect the Telegram
   identity, and explicitly confirm it.
4. Send another Telegram message. It enters the space's canonical
   Ship conversation.

Issuing or inspecting a code never suspends an existing link. Confirmation
activates a new route with a fresh generation, and cleanup of the previous
installation is retried until it is complete. A queued inbound message or
outbound reply retains that generation and cannot cross a relink.

## Webhook Endpoint

The Worker receives updates only on:

```text
POST /webhook
```

The worker verifies `X-Telegram-Bot-Api-Secret-Token` before forwarding messages to the Gateway through the `adapter.inbound` syscall over Service Binding RPC.
The peer Durable Object queues each message-bearing Telegram update before
returning success to the webhook and retries pending updates with its existing
alarm. Stable Telegram message identifiers make Kernel replays idempotent.

Human-approval prompts in direct messages use native buttons. Callback
correlation remains opaque and adapter-owned; a selection invokes exact
`proc.hil` through the linked human's interaction-scoped peer. The original
message is replaced with the resolved decision and action.

## Supported surfaces

Only private direct messages are admitted. Group, channel, and bot messages are
rejected before they can allocate a peer or select a space.
