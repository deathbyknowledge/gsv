# GSV Telegram Channel

Telegram bot integration for GSV Gateway using the Telegram Bot API webhook flow.

## Outbound Media

- Supports outbound attachments for `image`, `video`, `audio`, and `document`.
- Supports media groups (albums) with 2-10 attachments.
- Telegram rule is enforced: groups containing `audio` must be all-audio, and groups containing `document` must be all-document.
- Attachment source can be `url` or base64 `data`.
- If `text` is present, it is sent as caption (for groups, caption is applied to the first item).

## Required Secrets

Set these on the channel worker:

- `TELEGRAM_BOT_TOKEN` -- bot token from BotFather
- `TELEGRAM_WEBHOOK_BASE_URL` -- public base URL for this worker (for example `https://gsv-channel-telegram.<subdomain>.workers.dev`)

## Usage

Start the account:

```bash
gsv channel telegram start
```

Check status:

```bash
gsv channel telegram status
```

Stop and delete webhook:

```bash
gsv channel telegram stop
```

## Webhook Endpoint

Telegram updates are received on:

```text
POST /webhook/:accountId
```

The worker verifies `X-Telegram-Bot-Api-Secret-Token` before forwarding messages to the Gateway via Service Binding RPC.
