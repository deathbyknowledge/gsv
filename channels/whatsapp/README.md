# GSV WhatsApp Channel

WhatsApp channel integration for GSV using the [Baileys](https://github.com/WhiskeySockets/Baileys) library.

## Architecture

```
┌──────────────────┐   [Service Binding RPC]    ┌─────────────────┐
│  WhatsApp DO     │ ─────────────────────────▶ │    Gateway      │
│  (Baileys WS)    │   channelInbound/status    │  Entrypoint     │
└──────────────────┘                            └────────┬────────┘
        ▲                                                │
        │                                                │
        └────────[Service Binding RPC]───────────────────┘
              WhatsAppChannelEntrypoint.send()
```

**Inbound messages** (user → bot): WhatsApp DO calls Gateway via Service Binding RPC (`channelInbound`).

**Outbound messages** (bot → user): Gateway calls WhatsApp channel via Service Binding RPC.

## Account ID

Each WhatsApp account is managed by a Durable Object, identified by an `accountId` (e.g., `"default"`).

The account ID must be passed to the DO via the `X-Account-Id` header on every request. The DO stores this in `storage.kv` for persistence across hibernation.

## Endpoints

The channel worker exposes HTTP endpoints at `/account/:accountId/...`:

- `GET /account/:id/status` - Get account status
- `POST /account/:id/login` - Start login flow (returns QR code)
- `POST /account/:id/logout` - Logout and clear credentials
- `POST /account/:id/wake` - Wake up and reconnect
- `POST /account/:id/stop` - Stop the connection
- `POST /account/:id/send` - Send a message (used by Gateway)

## Development

```bash
npm install
npm run dev
```

## Deployment

Deployed via Alchemy from the gateway directory:

```bash
cd ../gateway
bun alchemy/deploy.ts --whatsapp
```
