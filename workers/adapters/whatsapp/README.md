# GSV WhatsApp Adapter

WhatsApp integration for GSV Gateway on the WhatsApp Business Platform Cloud
API, using Meta's webhook flow.

GSV uses one operator-owned WhatsApp Business phone number. A person messages
that number, receives a short-lived code, and confirms the displayed WhatsApp
identity from a direct signed-in GSV session. The access token and app secret
stay on the adapter Worker; individual spaces never accept or store them.

The Worker is `src/managed.ts` with `wrangler.managed.jsonc`. It keeps one
peer Durable Object per WhatsApp number that writes to the platform number and
a separate short-lived pairing object per code. A Meta application accepts one
webhook callback URL, so staging and production require different Meta apps or
different phone numbers.

## Availability

Meta's Business Solution Terms restrict general-purpose assistants on the
WhatsApp Business Platform. At the time of writing the exception covers users
whose registered numbers have European Economic Area or Brazilian country codes,
so the operator's offer is not worldwide. Account eligibility, pricing, and
country coverage must be rechecked when the number is provisioned; see the
hosting plan in `engineering/unified-hosting-and-web-release.md`.

## Inbound

- Text, images, documents, audio and voice notes, video, stickers, and shared
  locations. Media is looked up by id through the Graph media endpoint,
  downloaded with the access token, and relayed as a resource reference through
  the same binary body path the Telegram adapter uses.
- Reply buttons on approval prompts arrive as interactive replies and are
  correlated to the prompt through the adapter-owned token.
- Reactions, contact cards, list replies, and other message types receive a
  short reply explaining they are not relayed.
- Each accepted message is marked read.

## Outbound

- Text is rendered from Markdown with WhatsApp's own markers and split into
  messages of at most 4096 characters at paragraph, line, or word boundaries.
- `image`, `video`, `audio`, and `document` attachments are sent one message
  each. Bytes from the request body are uploaded to the number's media store
  and referenced by id; a `url` attachment is passed as a link. The text becomes
  the caption of the first attachment when WhatsApp accepts a caption for it and
  it fits 1024 characters; otherwise it is sent as its own message first.
- Meta accepts free-form messages only within 24 hours of the person's last
  message. The peer tracks that receipt and fails a later send with a specific
  error before contacting Meta. Message templates, which Meta requires outside
  that window, are not implemented.
- Typing is shown by attaching WhatsApp's typing indicator to the read receipt
  of the person's last message.

## Configuration

The platform operator configures these Worker secrets and variables:

- `WHATSAPP_ACCESS_TOKEN` — a System User access token with the
  `whatsapp_business_messaging` and `whatsapp_business_management` permissions
- `WHATSAPP_APP_SECRET` — the Meta app secret used to verify webhook signatures
- `WHATSAPP_VERIFY_TOKEN` — the random token entered in the Meta webhook setup
- `WHATSAPP_PHONE_NUMBER_ID` — the Graph id of the business phone number
- `WHATSAPP_BUSINESS_ACCOUNT_ID` — the WhatsApp Business Account id
- `WHATSAPP_WEBHOOK_BASE_URL` — the adapter Worker's public origin
- `WHATSAPP_DISPLAY_NUMBER` — the number people message, in E.164, shown in GSV
- `WHATSAPP_ALLOWED_ACTOR_IDS` — optional comma-separated staging allowlist

In the Meta app, the WhatsApp product's webhook callback URL is
`<WHATSAPP_WEBHOOK_BASE_URL>/webhook` with the verify token, subscribed to the
`messages` field of the business account. Notifications for other phone
numbers on the same account are acknowledged and ignored.

## Usage

1. Send any message to the GSV WhatsApp number. Send `/link` to request a new
   code when the number is already connected somewhere.
2. Copy the 12-character code from its reply.
3. Open **GSV → Settings → Messengers → WhatsApp**, enter the code, inspect the
   name and masked number, and explicitly confirm it.
4. Send another WhatsApp message. It enters the space's canonical Ship
   conversation.

Issuing or inspecting a code never suspends an existing link. Confirmation
activates a new route with a fresh generation, and cleanup of the previous
installation is retried until it is complete. A queued inbound message or
outbound reply retains that generation and cannot cross a relink.

## Webhook Endpoint

The Worker serves Meta on:

```text
GET  /webhook   subscription handshake (hub.mode, hub.verify_token, hub.challenge)
POST /webhook   notifications
```

Every notification must carry `X-Hub-Signature-256`, the HMAC-SHA256 of the
raw body with the app secret. The Worker checks the header shape before reading
a bounded body, verifies the signature over the exact bytes before parsing, and
drops statuses, other change fields, and group traffic. Accepted messages are
queued in the peer Durable Object before the webhook returns and retried with
its alarm. Stable WhatsApp message ids make Kernel replays idempotent.

Human-approval prompts use native reply buttons. Button correlation remains
opaque and adapter-owned; a selection invokes exact `proc.hil` through the
linked human's interaction-scoped peer. WhatsApp cannot edit a sent message, so
the decision is sent as a reply quoting the prompt.

## Supported surfaces

Only direct messages to the business number are admitted. Group messages and
notifications for other numbers on the account are rejected before they can
allocate a peer or select a space.
