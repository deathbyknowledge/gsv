# GSV Telegram Adapter

Telegram bot integration for GSV Gateway using the Telegram Bot API webhook flow.
The default deployment remains the user-owned, standalone adapter. A separate
managed deployment serves the platform-owned shared bot.

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

### Managed service

The managed bot is a distinct Worker described by `wrangler.managed.jsonc`.
It does not replace or migrate standalone account objects. Configure these as
Worker secrets on that deployment:

- `TELEGRAM_BOT_TOKEN` -- the single platform-owned bot token
- `TELEGRAM_BOT_USERNAME` -- the public BotFather username, with or without the
  leading `@`; the account service reads it through the adapter's service
  binding so Telegram presentation remains adapter-owned
- `TELEGRAM_WEBHOOK_SECRET` -- the Telegram webhook verification secret
- `TELEGRAM_CLAIM_SIGNING_KEY` -- an independent random secret of at least 32
  bytes used only to sign short-lived account-link claims

`GSV_ACCOUNT_ORIGIN` defaults to `https://accounts.gsv.space`. The bot webhook
must point to `POST https://telegram.gsv.space/webhook` and use the same
verification secret. Deploy with:

```bash
npm run deploy:managed
```

The managed bot is intentionally read-only through installation adapter
administration: customers cannot connect, disconnect, or replace it. Launch
traffic is private-DM text only; groups, channels, and media are rejected before
they reach a Kernel or model.

## Usage

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

## Standalone Webhook Endpoint

Telegram updates are received on:

```text
POST /webhook/:accountId
```

The worker verifies `X-Telegram-Bot-Api-Secret-Token` before forwarding messages to the Gateway through the `adapter.inbound` syscall over Service Binding RPC.
The account Durable Object queues each message-bearing Telegram update before
returning success to the webhook and retries pending updates with its existing
alarm. Stable Telegram message identifiers make Kernel replays idempotent.

Human-approval prompts in direct messages include a `hil[requestId]` token.
Replies must include the exact current token; bare decisions and stale tokens
are rejected.

## Group Activation

Group and channel messages set `wasMentioned: true` when they mention the bot's
username or reply to one of the bot's messages. Direct messages always set it
to true.
