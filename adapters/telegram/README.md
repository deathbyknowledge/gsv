# GSV Telegram Adapter

Telegram bot integration for GSV Gateway using the Telegram Bot API webhook flow.

GSV supports two deliberately separate deployments:

- Standalone GSV uses a bot owned by the deployment. The user creates it with
  BotFather and connects its token to one installation.
- Managed GSV uses one platform-owned bot. A Telegram user messages that bot,
  receives a short-lived code, and confirms the displayed identity from a
  direct signed-in GSV session. The bot token never enters the installation or
  the browser.

The managed worker is `src/managed.ts` with `wrangler.managed.jsonc`. It keeps
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

### Standalone

The deploy flow configures `TELEGRAM_WEBHOOK_BASE_URL` automatically from the
worker's workers.dev URL. Set the bot token on the adapter worker, or pass it in
the `adapter.connect` config:

- `TELEGRAM_BOT_TOKEN` -- bot token from BotFather

For a custom domain, pass `webhookBaseUrl` in the connect config.

### Managed

The platform operator configures these Worker secrets and variables:

- `TELEGRAM_BOT_TOKEN` — the platform bot token
- `TELEGRAM_WEBHOOK_SECRET` — a random Bot API webhook secret
- `TELEGRAM_BOT_USERNAME` — the public bot username shown in GSV
- `TELEGRAM_ALLOWED_ACTOR_IDS` — optional comma-separated staging allowlist

The managed Worker accepts only `POST /webhook`. It verifies the secret header
before reading a bounded request body and rejects group, channel, and bot
messages. The platform reconciles `setWebhook` only after the Worker, its
Durable Objects, and both Gateway service bindings are healthy.

## Usage

### Standalone

Connect the account:

```bash
gsv adapter connect --adapter telegram --account-id default
```

Check status:

```bash
gsv adapter status --adapter telegram --account-id default
```

Stop and delete webhook:

```bash
gsv adapter disconnect --adapter telegram --account-id default
```

### Managed

1. Send any private message to the official GSV bot.
2. Copy the 12-character code from its reply.
3. Open **GSV → Messengers → Telegram**, enter the code, inspect the Telegram
   identity, and explicitly confirm it.
4. Send another Telegram message. It enters the installation's canonical
   Personal process.

Issuing or inspecting a code never suspends an existing link. Confirmation
activates a new route with a fresh generation, and cleanup of the previous
installation is retried until it is complete. A queued inbound message or
outbound reply retains that generation and cannot cross a relink.

## Webhook Endpoint

The standalone Worker receives updates on:

```text
POST /webhook/:accountId
```

The managed Worker receives updates only on:

```text
POST /webhook
```

The worker verifies `X-Telegram-Bot-Api-Secret-Token` before forwarding messages to the Gateway through the `adapter.inbound` syscall over Service Binding RPC.
The account Durable Object queues each message-bearing Telegram update before
returning success to the webhook and retries pending updates with its existing
alarm. Stable Telegram message identifiers make Kernel replays idempotent.

Human-approval prompts in direct messages use native buttons. Callback
correlation remains opaque and adapter-owned; a selection invokes exact
`proc.hil` through the linked human's interaction-scoped peer. The original
message is replaced with the resolved decision and action.

## Group Activation

Group and channel messages set `wasMentioned: true` when they mention the bot's
username or reply to one of the bot's messages. Direct messages always set it
to true.
