# GSV WhatsApp Adapter

WhatsApp integration for GSV Gateway on the WhatsApp Business Platform Cloud
API, using Meta's webhook flow.

GSV uses one operator-owned WhatsApp Business phone number. A person messages
that number, receives a short-lived code, and confirms the displayed WhatsApp
identity from a direct signed-in GSV session. The access token and app secret
stay on the adapter Worker; individual spaces never accept or store them.

The Worker is `src/managed.ts` with `wrangler.managed.jsonc`. It keeps one
peer Durable Object per WhatsApp number that writes to the platform number and
a separate short-lived pairing object per code. Use separate Meta apps and
phone numbers when staging and production run concurrently, so each stage has
its own webhook configuration and credentials.

## Availability

Before enabling this adapter, the operator must verify that its Meta account
and GSV's personal-assistant use are eligible under the current
[WhatsApp Business Platform Terms](https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-Platform)
and the Meta Terms for WhatsApp Business Platform they incorporate. Earlier research about regional
exceptions predates the September 23, 2026 terms and does not establish current
eligibility. The adapter does not enforce or assume a geographic exception.

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

- A reply goes out as paragraph messages: the Markdown is split at blank lines
  by the shared splitter in `workers/adapters/shared/src/paragraph-messages.ts`,
  headings stay with the following block, and fenced code blocks, lists, tables
  and quotations stay whole. Short prose paragraphs are separate messages too.
  Each message
  is rendered with WhatsApp's own markers and kept within Meta's 4096 character
  limit by splitting the Markdown further and rendering again. Only the first
  message quotes the inbound message; the typing indicator is refreshed between
  messages; an approval prompt keeps its reply buttons on the last message.
- Every accepted message is recorded in the delivery ledger before the next
  one is sent, so a retry after a retryable rejection resumes at the first
  message the person has not received; an interrupted delivery stays ambiguous
  and is never replayed.
  A successful Graph response must include a message id; an incomplete success
  response also stays ambiguous rather than being recorded as delivered.
  If the reply window closes after some parts were delivered, the remaining
  delivery fails without sending the original text again through a template.
- `image`, `video`, `audio`, and `document` attachments are sent one message
  each. Bytes from the request body are uploaded to the number's media store
  and referenced by id; a `url` attachment is passed as a link. The text becomes
  the caption of the first attachment when WhatsApp accepts a caption for it and
  it fits 1024 characters; otherwise it is sent as paragraph messages first.
- Meta accepts free-form messages, buttons included, only within 24 hours of
  the person's last message. Inside that window the adapter never uses a
  template. Outside it the adapter sends the operator's message template
  instead; see below.
- Typing is shown by attaching WhatsApp's typing indicator to the read receipt
  of the person's last message.

## Message templates

Outside the 24-hour customer service window Meta accepts only a pre-approved
template, and a template does not reopen the window; only the person's reply
does, and a tap on a quick-reply button counts as a reply. Meta bills each
template sent outside the window at the category assigned to it.

The adapter uses a template with one body parameter and one quick-reply
button. File it in Meta's message template manager and wait for approval:

- Category: **Marketing** for this general update; do not assume a Utility rate
- Name: `gsv_message` (or `WHATSAPP_TEMPLATE_NAME`)
- Language: English (`en`, or `WHATSAPP_TEMPLATE_LANGUAGE`)
- Header and footer: none
- Body: `Your GSV has an update about your request: {{1}} Tap below to continue in WhatsApp.`
- Button: type **Quick reply**, label `Show me`

Use this body contract even if you customize the template name: the adapter
budgets the parameter against its surrounding text and Meta's 1,024-character
body limit. Leave `WHATSAPP_TEMPLATE_NAME` empty until your template is approved.

When the local receipt says the window is closed, or Meta rejects the first
free-form part with error 131047, the template carries the actual message.
Paragraphs become a single line. If the message is too long, it carries a
preview ending with **Open GSV for the full message.** The complete original
remains in the canonical GSV conversation, with its formatting and attachments.
An approval notification directs the person to review the request in GSV;
templates do not carry approval controls.

There is no adapter outbox or automatic replay when the person replies. Each
new message uses its own template; the delivery ledger still deduplicates
retries and preserves ambiguous outcomes. **Show me** is an ordinary user
reply forwarded to Ship, as is a typed follow-up such as “What did you say?”.
Incoming replies do not wait for earlier outbound sends to finish.

On upgrade, the adapter discards old outbox copies and pending notification
markers; the canonical conversation retains the originals. Old internal
replay receipts complete without sending. Replies admitted before the upgrade
retain their original deduplication identity and route generation.

Attachments cannot be sent through this text template: out-of-window media
sends fail explicitly. Use another authorized destination or wait for a reply.
With an empty template name, out-of-window delivery fails with a configuration
error. A template Meta does not know or has paused fails with its 1320xx code.
Neither failure is silently treated as delivery.

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
- `WHATSAPP_TEMPLATE_NAME` — the notification template sent outside the 24-hour
  window; defaults to `gsv_message`, and an empty value switches templates off
- `WHATSAPP_TEMPLATE_LANGUAGE` — that template's language code; defaults to `en`
- `WHATSAPP_ALLOWED_ACTOR_IDS` — optional comma-separated staging allowlist

The template values are declared with their defaults in
`wrangler.managed.jsonc`; the operator stack overrides them only when the
template was filed under another name or language.

In the Meta app, the WhatsApp product's webhook callback URL is
`<WHATSAPP_WEBHOOK_BASE_URL>/webhook` with the verify token, subscribed to the
`messages` field of the business account. Notifications for other phone
numbers on the same account are acknowledged and ignored.

## Usage

1. Send any message to the GSV WhatsApp number. Send `/link` to request a new
   code when the number is already connected somewhere.
2. Copy the code-only message that follows the instructions. It expires in 10 minutes.
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
