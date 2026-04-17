# GSV Channel Architecture

## Overview

Channels are separate Cloudflare Workers that handle platform-specific messaging.
Each channel connects to the Gateway via **Service Bindings** (RPC).

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           GSV Gateway Worker                             │
│  ┌──────────────────┐                                                   │
│  │   Gateway DO     │◄─── Service Bindings ───┐                         │
│  │   Session DOs    │                         │                         │
│  └──────────────────┘                         │                         │
│           │                                   │                         │
│   env.DISCORD ─────────────────┐              │                         │
│   env.WHATSAPP ────────────────┼──────────────┤                         │
│   env.EMAIL ───────────────────┘              │                         │
└───────────────────────────────────────────────┼─────────────────────────┘
                                                │
        ┌───────────────────────────────────────┼───────────────────────┐
        │                                       │                       │
        ▼                                       ▼                       ▼
┌───────────────────┐              ┌───────────────────┐    ┌───────────────────┐
│  Discord Worker   │              │  WhatsApp Worker  │    │   Email Worker    │
│                   │              │                   │    │                   │
│  DiscordGateway   │              │  WhatsAppAccount  │    │   EmailAccount    │
│  (Durable Object) │              │  (Durable Object) │    │  (Durable Object) │
│                   │              │                   │    │                   │
│  - WebSocket to   │              │  - Baileys WS     │    │  - IMAP polling   │
│    Discord API    │              │  - QR auth        │    │  - SMTP send      │
│  - Heartbeats     │              │  - Media upload   │    │  - Webhook recv   │
└───────────────────┘              └───────────────────┘    └───────────────────┘
```

## Interface

All channel workers implement `ChannelWorkerInterface` (see `gateway/src/channel-interface.ts`):

```typescript
interface ChannelWorkerInterface {
  // Identity
  readonly channelId: string;
  readonly capabilities: ChannelCapabilities;
  
  // Lifecycle
  start(accountId: string, config: Record<string, unknown>): Promise<StartResult>;
  stop(accountId: string): Promise<StopResult>;
  status(accountId?: string): Promise<ChannelAccountStatus[]>;
  
  // Messaging
  send(accountId: string, message: ChannelOutboundMessage): Promise<SendResult>;
  setTyping?(accountId: string, peer: ChannelPeer, typing: boolean): Promise<void>;
  
  // Auth (optional)
  login?(accountId: string, options?: { force?: boolean }): Promise<LoginResult>;
  logout?(accountId: string): Promise<LogoutResult>;
}
```

## Channel Workers

### Discord Channel (`gsv-channel-discord`)

**Connection:** Discord Gateway WebSocket (persistent via Durable Object)

**Architecture:**
```
┌─────────────────────────────────────────────────────────────┐
│  Discord Channel Worker                                      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  WorkerEntrypoint (implements ChannelWorkerInterface) │   │
│  │                                                       │   │
│  │  start() → gets/creates DiscordGateway DO            │   │
│  │  send()  → calls Discord REST API                     │   │
│  │  status()→ queries DO state                           │   │
│  └──────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  DiscordGateway DO (one per bot token/account)        │   │
│  │                                                       │   │
│  │  - Maintains WebSocket to Discord Gateway             │   │
│  │  - Handles IDENTIFY, HEARTBEAT, RESUME               │   │
│  │  - Dispatches MESSAGE_CREATE → Gateway.channelInbound│   │
│  │  - Uses alarm() for heartbeat timing                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Service Binding: GATEWAY → gsv-gateway                     │
└─────────────────────────────────────────────────────────────┘
```

**Config:**
```yaml
channels:
  discord:
    enabled: true
    accounts:
      default:
        botToken: "..."
        # OR use secret
        botTokenSecret: "DISCORD_BOT_TOKEN"
```

**Capabilities:**
- Chat types: dm, group (guild channels), thread
- Media: yes (embeds, attachments)
- Reactions: yes
- Typing: yes
- Threads: yes
- Editing: yes
- QR login: no (token-based)

---

### WhatsApp Channel (`gsv-channel-whatsapp`)

**Connection:** Baileys WebSocket (via Durable Object)

**Architecture:** (Existing, needs update to new interface)
```
┌─────────────────────────────────────────────────────────────┐
│  WhatsApp Channel Worker                                     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  WorkerEntrypoint (implements ChannelWorkerInterface) │   │
│  │                                                       │   │
│  │  start() → gets/creates WhatsAppAccount DO           │   │
│  │  send()  → calls DO.sendMessage()                    │   │
│  │  login() → initiates QR flow                         │   │
│  └──────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  WhatsAppAccount DO (one per phone number)            │   │
│  │                                                       │   │
│  │  - Baileys socket connection                          │   │
│  │  - Auth state in DO storage                          │   │
│  │  - QR code generation for login                      │   │
│  │  - Message handling → Gateway.channelInbound         │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Service Binding: GATEWAY → gsv-gateway                     │
└─────────────────────────────────────────────────────────────┘
```

**Config:**
```yaml
channels:
  whatsapp:
    enabled: true
    accounts:
      default:
        # No token needed - uses QR login
```

**Capabilities:**
- Chat types: dm, group
- Media: yes (images, audio, video, documents)
- Reactions: yes
- Typing: yes
- Threads: no (WhatsApp doesn't have threads)
- QR login: yes

---

### Email Channel (`gsv-channel-email`)

**Connection:** IMAP polling + SMTP sending (or API like SendGrid/Mailgun)

**Architecture:**
```
┌─────────────────────────────────────────────────────────────┐
│  Email Channel Worker                                        │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  WorkerEntrypoint (implements ChannelWorkerInterface) │   │
│  │                                                       │   │
│  │  start() → creates EmailAccount DO, starts polling   │   │
│  │  send()  → SMTP or API call                          │   │
│  └──────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  EmailAccount DO                                      │   │
│  │                                                       │   │
│  │  Option A: IMAP polling                               │   │
│  │  - alarm() triggers IMAP check every N minutes       │   │
│  │  - Tracks last seen message ID                       │   │
│  │                                                       │   │
│  │  Option B: Webhook receiver                          │   │
│  │  - SendGrid/Mailgun inbound parse webhook            │   │
│  │  - Worker fetch() handles POST from email service    │   │
│  │                                                       │   │
│  │  Either way → Gateway.channelInbound                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Service Binding: GATEWAY → gsv-gateway                     │
└─────────────────────────────────────────────────────────────┘
```

**Config:**
```yaml
channels:
  email:
    enabled: true
    accounts:
      default:
        # Option A: Direct IMAP/SMTP
        imap:
          host: "imap.gmail.com"
          user: "bot@example.com"
          password: "..." # or passwordSecret
        smtp:
          host: "smtp.gmail.com"
          user: "bot@example.com"
          password: "..."
        
        # Option B: Email service API
        provider: "sendgrid" # or "mailgun", "postmark"
        apiKey: "..."
        inboundWebhookSecret: "..." # verify webhook signatures
```

**Capabilities:**
- Chat types: dm (email is 1:1 or mailing list)
- Media: yes (attachments)
- Reactions: no
- Typing: no
- Threads: yes (email threading via In-Reply-To)

---

## Gateway Integration

### Service Bindings Config

```jsonc
// gateway/wrangler.jsonc
{
  "name": "gsv-gateway",
  "services": [
    { "binding": "DISCORD", "service": "gsv-channel-discord" },
    { "binding": "WHATSAPP", "service": "gsv-channel-whatsapp" },
    { "binding": "EMAIL", "service": "gsv-channel-email" }
  ]
}
```

### Channel Registry in Gateway

```typescript
// gateway/src/channel-registry.ts
export class ChannelRegistry {
  private channels: Map<string, ChannelWorkerInterface>;
  
  constructor(env: Env) {
    this.channels = new Map();
    
    // Register channels from service bindings
    if (env.DISCORD) this.channels.set("discord", env.DISCORD);
    if (env.WHATSAPP) this.channels.set("whatsapp", env.WHATSAPP);
    if (env.EMAIL) this.channels.set("email", env.EMAIL);
  }
  
  get(channelId: string): ChannelWorkerInterface | undefined {
    return this.channels.get(channelId);
  }
  
  list(): string[] {
    return Array.from(this.channels.keys());
  }
}
```

### Inbound Message Flow

1. Channel DO receives platform message (Discord MESSAGE_CREATE, WhatsApp msg, email)
2. Channel DO calls `env.GATEWAY.channelInbound(channelId, accountId, message)`
3. Gateway routes to appropriate Session DO
4. Session processes with LLM
5. Session broadcasts response
6. Gateway calls `channel.send(accountId, outboundMessage)`

---

## Alchemy Deployment

Alchemy conditionally deploys channels based on config:

```typescript
// gateway/alchemy/index.ts
import { Worker } from "alchemy";

// Always deploy gateway
const gateway = new Worker("gsv-gateway", {
  name: "gsv-gateway",
  entrypoint: "./src/index.ts",
  // ...
});

// Conditionally deploy channels
if (config.channels?.discord?.enabled) {
  const discord = new Worker("gsv-channel-discord", {
    name: "gsv-channel-discord",
    entrypoint: "../adapters/discord/src/index.ts",
    durableObjects: [{ name: "DISCORD_GATEWAY", className: "DiscordGateway" }],
    services: [{ binding: "GATEWAY", service: "gsv-gateway" }],
  });
}

if (config.channels?.whatsapp?.enabled) {
  const whatsapp = new Worker("gsv-channel-whatsapp", {
    name: "gsv-channel-whatsapp",
    entrypoint: "../adapters/whatsapp/src/index.ts",
    durableObjects: [{ name: "WHATSAPP_ACCOUNT", className: "WhatsAppAccount" }],
    services: [{ binding: "GATEWAY", service: "gsv-gateway" }],
  });
}

if (config.channels?.email?.enabled) {
  const email = new Worker("gsv-channel-email", {
    name: "gsv-channel-email",
    entrypoint: "../adapters/email/src/index.ts",
    durableObjects: [{ name: "EMAIL_ACCOUNT", className: "EmailAccount" }],
    services: [{ binding: "GATEWAY", service: "gsv-gateway" }],
  });
}
```

---

## Migration Plan

1. **Create shared types package** (`@gsv/channel-interface`)
2. **Update WhatsApp channel** to implement new interface
3. **Build Discord channel** from scratch
4. **Build Email channel** 
5. **Update Gateway** to use ChannelRegistry
6. **Update Alchemy** for conditional deployment

---

## Future Channels

Easy to add following this pattern:
- **Telegram** - Bot API, simple HTTP polling or webhook
- **Slack** - Socket Mode or Events API
- **Matrix** - Client-Server API
- **SMS** - Twilio/Vonage API
