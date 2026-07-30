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

While connected, the Durable Object rotates its outbound WebSocket every ten
minutes. Rotation retains authentication and is not a logout. This keeps the
transport inside Cloudflare's current maximum 15-minute outbound-WebSocket
keepalive window while leaving alarms as scheduled lifecycle events rather than
an always-on mechanism.

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

## Development

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
