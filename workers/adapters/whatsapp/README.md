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

- A reply goes out as paragraph messages: the Markdown is split at blank lines
  by the shared splitter in `workers/adapters/shared/src/paragraph-messages.ts`,
  fenced code blocks, lists and tables stay whole, and runs of short paragraphs
  merge so a greeting and a one-line question stay in one bubble. Each message
  is rendered with WhatsApp's own markers and kept within Meta's 4096 character
  limit by splitting the Markdown further and rendering again. Only the first
  message quotes the inbound message; the typing indicator is refreshed between
  messages; an approval prompt keeps its reply buttons on the last message.
- Every accepted message is recorded in the delivery ledger before the next
  one is sent, so a retry after a retryable rejection resumes at the first
  message the person has not received; an interrupted delivery stays ambiguous
  and is never replayed.
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
template sent outside the window per message under its utility rate.

The adapter uses one Utility template with a single body parameter and one
quick-reply button. The operator files it once in the Meta app under
**WhatsApp → Message templates → Create template** and waits for Meta's
review, which usually completes within minutes but may take up to a day:

- Category: **Utility**
- Name: `gsv_message` (or the value of `WHATSAPP_TEMPLATE_NAME`)
- Language: English (`en`, or the value of `WHATSAPP_TEMPLATE_LANGUAGE`)
- Header and footer: none
- Body: `Your GSV: {{1}}`
- Body parameter example (Meta asks for one during review):
  `Your report is ready. Tap the button to read it here.`
- Button: type **Quick reply**, label `Show me`

The parameter receives the reply flattened to one line: paragraphs join with
` · `, WhatsApp markers and code fences are removed, and whitespace collapses,
because Meta refuses newlines, tabs and more than four consecutive spaces in a
parameter. The value is cut to 1000 characters with an ellipsis so the rendered
body stays under Meta's 1024 character cap.

Behaviour once the template is approved:

- When the peer's own receipt says the window is closed, or Meta answers a
  free-form send with error 131047, the template goes out instead.
- A reply that fits the parameter is delivered by the template alone.
- A longer reply, or an approval prompt whose buttons the template cannot
  carry, is held in the peer's storage and reported to the Kernel as accepted.
  The person's next message, or the tap on **Show me**, opens the window and
  releases the held messages in order through the normal free-form path with
  paragraph splitting, before their own message is relayed. The tap itself is
  not relayed to the Process.
- One template is pending at a time. While it is, further replies wait behind
  it rather than each sending a template. Held messages and the pending
  template expire after seven days.
- Attachments cannot wait behind a template; a send with media outside the
  window fails with a specific error.
- With `WHATSAPP_TEMPLATE_NAME` set to an empty value, no template is used and
  a send outside the window fails with `WhatsApp customer service window is
  closed: this number has not messaged GSV in the last 24 hours, and no
  template is configured` and a pointer to this section. A template Meta does
  not know or has paused fails with Meta's 1320xx code and the same pointer.

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
- `WHATSAPP_TEMPLATE_NAME` — the Utility template sent outside the 24-hour
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
