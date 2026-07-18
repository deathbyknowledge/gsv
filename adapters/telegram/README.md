# GSV Telegram Adapter

Telegram bot integration for GSV Gateway using the Telegram Bot API webhook flow.

## Outbound Media

- Supports outbound attachments for `image`, `video`, `audio`, and `document`.
- Supports media groups (albums) with 2-10 attachments.
- Telegram rule is enforced: groups containing `audio` must be all-audio, and groups containing `document` must be all-document.
- Attachment source can be `url` or a range in the request's top-level binary body.
- If `text` is present, it is sent as caption (for groups, caption is applied to the first item).

## Configuration

The deploy flow configures `TELEGRAM_WEBHOOK_BASE_URL` automatically from the
worker's workers.dev URL. Set the bot token on the adapter worker, or pass it in
the `adapter.connect` config:

- `TELEGRAM_BOT_TOKEN` -- bot token from BotFather

For a custom domain, pass `webhookBaseUrl` in the connect config.

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

## Webhook Endpoint

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
