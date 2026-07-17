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

**Outbound messages** (bot → user): Gateway calls `adapterSend` on the WhatsApp service-binding entrypoint.

## Account ID

Each WhatsApp account is managed by a Durable Object, identified by an `accountId` (e.g., `"default"`).

The account ID must be passed to the DO via the `X-Account-Id` header on every request. The DO stores this in `storage.kv` for persistence across hibernation.

## Lifecycle

Account control is service-binding only. Use the canonical adapter commands:

```bash
gsv adapter connect --adapter whatsapp --account-id default
gsv adapter status --adapter whatsapp --account-id default
gsv adapter disconnect --adapter whatsapp --account-id default
```

The account Durable Object retains a small internal HTTP surface for status,
login, logout, and typing activity. The public worker does not expose account
control routes.

## Group Activation

Group messages set `wasMentioned: true` when the bot is mentioned directly or
when the message replies to one of the bot's messages. If WhatsApp omits the
quoted participant or the adapter cannot match its own JID, the metadata stays
false so the Gateway can reject the activation conservatively.

## Development

```bash
npm install
npm run dev
```

## Deployment

Deploy the adapter through the GSV infrastructure command:

```bash
gsv infra deploy -c channel-whatsapp
```
