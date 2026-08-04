# GSV WhatsApp Adapter

WhatsApp adapter integration for GSV using the [Baileys](https://github.com/WhiskeySockets/Baileys) library.

## Architecture

```
┌──────────────────┐   [Service Binding RPC]    ┌─────────────────┐
│  WhatsApp DO     │ ─────────────────────────▶ │    Gateway      │
│  (Baileys WS)    │ adapter.inbound/state.update │  Entrypoint   │
└──────────────────┘                            └────────┬────────┘
        ▲                                                │
        │                                                │
        └────────[Service Binding RPC]───────────────────┘
              WhatsAppChannelEntrypoint.adapterSend()
```

**Inbound messages** (user → bot): WhatsApp DO persists the protobuf message,
then sends a canonical `adapter.inbound` request frame through `serviceFrame`.
The record remains pending across transport failures and
`replayed: "in_progress"`; the existing account alarm retries it and reconstructs
media for each attempt. A terminal Kernel disposition removes the record.

**Outbound messages** (bot → user): Gateway calls `adapterSend` on the
WhatsApp service-binding entrypoint. Provider sends use a durable delivery
ledger so a retry cannot silently duplicate an ambiguous WhatsApp send.

## Account ID

Each WhatsApp account is managed by a Durable Object identified by a stable
local `accountId` (for example, `"default"` or `"account-2"`). The service
entrypoint resolves that object by name and invokes its typed RPC methods; the
public Worker does not expose account-control HTTP routes.

## Lifecycle

Account control is service-binding only. Use the canonical adapter commands:

```bash
gsv adapter connect --adapter whatsapp --account-id default
gsv adapter status --adapter whatsapp --account-id default
gsv adapter disconnect --adapter whatsapp --account-id default
```

Connect preserves registered credentials and reconnects an existing linked
device. `adapter.disconnect` is a real WhatsApp logout and clears those
credentials. A forced connect (`{"force":true}`) is destructive recovery that
clears the old link before producing a fresh QR challenge.

Pairing returns the raw WhatsApp QR payload and its expiry to the web UI for
local rendering. Explicit logout and forced relink advance a durable session
epoch so late sends, inbound replies, credentials, and Signal keys from the
old phone cannot cross into the new session.

Pairing authenticates the linked device; it does not yet authorize a WhatsApp
sender as a GSV user. After the account reports `authenticated`, send a new
direct message from the WhatsApp account that should represent the user to the
phone number paired with GSV. The adapter replies with a one-time link code.
Enter that code in the web UI's **Link user** step or run `gsv auth link CODE`
while signed in as the intended GSV user. The code expires after ten minutes.
The message that requests the code is consumed by the linking flow, so send a
new message after linking to start a conversation with an agent.

While connected, the outbound WhatsApp WebSocket initially prevents the account
Durable Object from being evicted. Cloudflare limits that keepalive effect to 15
minutes per outbound connection; the WebSocket itself may continue after that
point. GSV keeps the same provider session and schedules a Durable Object alarm
every 30 seconds. Each alarm is an incoming event inside Cloudflare's minimum
70-second idle-eviction window, so routine residency maintenance never opens a
second WhatsApp session. Baileys separately pings WhatsApp every 30 seconds and
the ordinary reconnect path replaces a transport only when it is unhealthy.

This design targets the free Workers and Durable Objects plan; it does not
require Containers. The account alarm also arbitrates pairing expiry,
connection watchdogs, reconnect backoff, and durable inbound retries.

Inbound media is authenticated and streamed through bounded temporary storage
up to 48 MiB. Outbound media is capped at 24 MiB aggregate because Baileys
stages a second encrypted copy during upload within the Durable Object's
128 MiB memory limit.

## Group Activation

Group messages set `wasMentioned: true` when the bot is mentioned directly or
when the message replies to one of the bot's messages. If WhatsApp omits the
quoted participant or the adapter cannot match its own JID, the metadata stays
false so the Gateway can reject the activation conservatively.

## Troubleshooting linking

- If WhatsApp shows GSV under **Linked Devices** but no link code arrives,
  confirm `gsv adapter status --adapter whatsapp --account-id ACCOUNT` reports
  the account connected and authenticated. Send a fresh direct message from
  the sender account to the paired GSV number; messages from the paired account
  itself and group messages do not start the identity-link flow.
- Pairing alone does not create an identity link. If the adapter is connected
  but does not reply, verify that both the Gateway and WhatsApp workers are
  deployed, that their service bindings target each other, and inspect both
  workers' live logs for the failed inbound or reply delivery.
- A link code is single-use and expires after ten minutes. Send another new
  direct message for a fresh code, then enter it in the web UI or run
  `gsv auth link CODE` while authenticated as the user to link.
- After the code is accepted, send another message. The message used to request
  the code is deliberately not replayed into an agent conversation.

## Development

`npm ci` applies narrowly scoped patches to the pinned provider dependencies.
The protobufjs patch supplies the explicit `Buffer.utf8Write` length required
by the Workers runtime; the Baileys and libsignal patches route or remove direct
console output that could expose provider session data. Re-review and regenerate
these patches whenever one of those dependencies is upgraded.

```bash
npm ci
npm run check
npm run bundle
npm run dev
```

## Deployment

Deploy the adapter through the GSV infrastructure command:

```bash
gsv infra deploy -c channel-whatsapp
```
