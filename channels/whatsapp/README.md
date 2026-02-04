# GSV WhatsApp Channel

WhatsApp channel integration for GSV using the [Baileys](https://github.com/WhiskeySockets/Baileys) library.

## Architecture

```
┌──────────────────┐                              ┌─────────────────┐
│  WhatsApp DO     │ ──[gateway-channel-inbound]──▶│    Gateway      │
│  (Baileys WS)    │         Queue                │   (consumer)    │
└──────────────────┘                              └────────┬────────┘
        ▲                                                  │
        │                                                  │
        └────────[Service Binding RPC]─────────────────────┘
              WhatsAppChannelEntrypoint.send()
```

**Inbound messages** (user → bot): WhatsApp DO sends to a Queue, which Gateway consumes.

**Outbound messages** (bot → user): Gateway calls WhatsApp channel via Service Binding RPC.

## Why Queue for Inbound?

We discovered that making Service Binding RPC calls **from a Durable Object that has an active Baileys WebSocket connection** causes message receiving to break silently. Messages with `fromMe=false` (from other users) would not be received.

### The Problem

When the WhatsApp DO tried to call Gateway directly via Service Binding RPC:
```typescript
// This BREAKS message receiving when called from DO with active Baileys WS
await this.env.GATEWAY.channelInbound(channelId, accountId, message);
```

The exact cause is unclear, but theories include:
- Service bindings may change the Worker's egress IP or network topology
- WhatsApp may reject messages to companion devices that appear to change IP mid-session
- Some interaction between Baileys' WebSocket and Cloudflare's RPC mechanism

### The Solution

Route inbound messages through a Cloudflare Queue:
```typescript
// This WORKS - decouples the RPC from the DO context
await this.env.GATEWAY_QUEUE.send({ type: "inbound", ... });
```

The Queue consumer runs in a separate worker invocation, which doesn't have the Baileys WebSocket baggage. This approach works reliably.

### Service Bindings for Outbound Work Fine

Interestingly, the reverse direction works fine:
- Gateway (no Baileys) → Service Binding RPC → WhatsApp Channel → DO

This suggests the issue is specific to making RPC calls **from** a DO with an active Baileys connection.

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
