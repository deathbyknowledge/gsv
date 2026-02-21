# The Channel Model

An AI agent that only lives in a terminal isn't very useful as personal infrastructure. You want to reach it from WhatsApp while walking the dog, from Discord while in a server with friends, from the CLI while coding, and maybe from a web UI while on your phone. The channel model is how GSV solves this: a unified abstraction that lets the same agent speak through any communication platform while maintaining coherent identity and, where appropriate, shared context.

## The Problem Channels Solve

The naive approach would be to add WhatsApp support directly into the Gateway Worker — import the Baileys library, manage WhatsApp authentication state, handle message parsing, all inside the same codebase. This would work initially but creates several problems:

**Dependency bloat.** Each messaging platform brings its own SDK, often with large dependency trees. Baileys (WhatsApp) pulls in Node.js compatibility layers, cryptographic libraries, and protocol buffers. Discord's integration needs its own WebSocket client and REST API wrappers. Bundling all of these into a single Worker makes the bundle huge and slow to deploy.

**Blast radius.** If the WhatsApp library has a bug that causes crashes, it shouldn't take down the entire Gateway. Separate workers provide fault isolation — a WhatsApp reconnection loop doesn't affect the agent's ability to respond to CLI messages.

**Deployment independence.** You might want to update the Discord channel to support new message types without redeploying the entire Gateway. Or you might not use Discord at all and don't want its code in your deployment.

**Always-on requirements.** WhatsApp and Discord both need persistent connections — WhatsApp maintains a Baileys WebSocket to Meta's servers, Discord maintains a Gateway WebSocket to Discord's API. These connections must stay alive to receive messages, which means they need their own Durable Objects with heartbeats and reconnection logic. Mixing these connection-management concerns with the Gateway's message-routing concerns would be messy.

## Service Bindings: The Connective Tissue

GSV's channel workers connect to the Gateway via Cloudflare Service Bindings — a mechanism that allows Workers to call each other's exported classes and methods directly, without going through HTTP. This is a crucial design choice.

The alternative would be HTTP webhooks. Channel workers could POST inbound messages to a Gateway endpoint, and the Gateway could POST outbound messages back. But webhooks have problems for this use case: they require public URLs, they need authentication, they add HTTP overhead for what's essentially in-process communication, and they make it awkward to pass complex typed payloads.

Service Bindings are different. When the WhatsApp Worker calls `env.GATEWAY.channelInbound(...)`, it's making a direct function call across Worker boundaries. No HTTP parsing, no URL routing, no serialization overhead beyond what's needed for the Worker sandbox boundary. The call is type-safe (at the TypeScript level, at least), fast, and authenticated implicitly by the Cloudflare account boundary — if the Service Binding exists, the caller is authorized.

This means channel trust is established at deploy time, not at runtime. If a Service Binding from the WhatsApp Worker to the Gateway exists, the WhatsApp Worker is trusted. There's no token exchange, no handshake, no revocable credentials. This is simpler and more robust than the alternatives, though it does mean that anyone with access to your Cloudflare account can deploy a channel that talks to your Gateway.

## Bidirectional RPC

The channel interface is bidirectional:

**Inbound (Channel → Gateway)**: When a WhatsApp message arrives, the channel worker calls `GatewayEntrypoint.channelInbound()` with the message, sender, and peer information. The Gateway routes this to the appropriate Session.

**Outbound (Gateway → Channel)**: When the agent responds, the Gateway calls `channel.send()` on the appropriate channel worker's Service Binding. The channel worker translates the response into platform-specific format and delivers it.

Both directions are defined by typed interfaces. `ChannelWorkerInterface` defines what the Gateway can ask of a channel (start, stop, send, status, login, logout). `GatewayChannelInterface` defines what channels can tell the Gateway (inbound message, status change).

This clean bidirectional contract means adding a new channel requires implementing one interface and configuring one Service Binding. The Gateway doesn't need to know anything platform-specific about the new channel.

## Session Key Derivation

When a message arrives from a channel, the Gateway needs to determine which Session DO should handle it. This is the session key derivation problem, and it's more nuanced than it first appears.

A session key encodes the conversation identity. The format is: `agent:{agentId}:{channel}:{peerKind}:{peerId}` — for example, `agent:main:whatsapp:dm:+1234567890` or `agent:main:discord:group:server-general`.

For groups, the derivation is straightforward: each group gets its own session. Messages in Discord's #general channel always go to the same session, regardless of who sent them. The agent maintains one conversation per group.

For DMs, it's more interesting, because GSV supports different **scoping modes** via the `dmScope` configuration:

- **`main`**: All DMs route to the agent's main session, regardless of sender or channel. This means your WhatsApp DM, Discord DM, and CLI session all share one conversation. The agent has a single thread of interaction with you. This is the default and the simplest model.

- **`per-peer`**: Each sender gets their own session, regardless of channel. Your WhatsApp messages and Discord messages would share a session (because you're the same person), but a friend messaging through WhatsApp would get a separate session. This requires identity linking to work across channels.

- **`per-channel-peer`**: Each sender on each channel gets a separate session. Your WhatsApp conversation and Discord conversation would be distinct, even though they're both with you.

- **`per-account-channel-peer`**: The most isolated mode. Each sender, on each channel, on each account gets a separate session. This matters if you have multiple WhatsApp accounts or Discord bots connected.

The `main` scope is the simplest and most common for personal use. The per-peer and per-channel-peer modes exist for scenarios where the agent serves multiple people (a family, a small team) and conversations need isolation.

### Identity Linking

One interesting problem arises with `per-peer` scoping: how does the Gateway know that WhatsApp user +1234567890 and Discord user `alice#1234` are the same person? The answer is identity linking — a configuration that maps channel-specific identifiers to a canonical identity. When identity linking is configured, `per-peer` routing uses the linked identity instead of the raw platform ID.

## Platform-Specific Quirks

Each channel worker handles the peculiarities of its platform, and those peculiarities are significant:

### WhatsApp

WhatsApp is built on Baileys, an unofficial library that reverse-engineers WhatsApp Web's protocol. This has several implications:

- **Authentication is stateful.** WhatsApp uses QR code pairing — you scan a code with your phone to authenticate. The resulting auth state (encryption keys, session tokens) must be persisted across Worker restarts. The WhatsApp channel stores this in its Durable Object's storage.

- **The connection must stay alive.** WhatsApp expects a persistent WebSocket connection. If it drops, messages are missed until reconnection. The Durable Object uses alarms and reconnection logic to maintain this.

- **Timer API incompatibilities.** Baileys was designed for Node.js and calls `.unref()` on timers, which doesn't exist in Cloudflare Workers. The WhatsApp channel includes polyfills that wrap timer IDs in objects with no-op `unref()` methods. This is the kind of pragmatic edge-case handling that channels encapsulate away from the Gateway.

- **Media handling.** WhatsApp messages can include images, audio (voice notes), video, and documents. The channel worker downloads these, transcribes audio if possible, and forwards them to the Gateway as structured media attachments.

### Discord

Discord uses a standard bot API, which is cleaner than WhatsApp's reverse-engineered protocol but has its own patterns:

- **Gateway WebSocket.** Discord requires bots to maintain a WebSocket connection to their Gateway API for receiving events. This involves handling IDENTIFY, HEARTBEAT, and RESUME sequences. The Discord channel uses a Durable Object to manage this persistent connection.

- **REST API for sending.** While events come in via WebSocket, sending messages uses Discord's REST API. The channel worker makes HTTP calls to `discord.com/api/v10` endpoints.

- **Richer peer types.** Discord has DMs, group channels, threads, and forum posts. The channel reports peer types that map to these constructs, allowing the session routing to handle groups differently from DMs.

- **Bot token authentication.** Unlike WhatsApp's QR flow, Discord uses a bot token — a simple string that authenticates all API calls. This can be stored as a Worker secret.

## The ChannelWorkerInterface Contract

Every channel implements the same interface:

```typescript
interface ChannelWorkerInterface {
  readonly channelId: string;
  readonly capabilities: ChannelCapabilities;

  start(accountId: string, config: Record<string, unknown>): Promise<StartResult>;
  stop(accountId: string): Promise<StopResult>;
  status(accountId?: string): Promise<ChannelAccountStatus[]>;
  send(accountId: string, message: ChannelOutboundMessage): Promise<SendResult>;
  setTyping?(accountId: string, peer: ChannelPeer, typing: boolean): Promise<void>;
  login?(accountId: string, options?: { force?: boolean }): Promise<LoginResult>;
  logout?(accountId: string): Promise<LogoutResult>;
}
```

The `capabilities` property is particularly useful. It declares what the channel supports: which conversation types (dm, group, thread), whether it handles media, reactions, typing indicators, message editing. The Gateway can use this to adapt its behavior — for example, not attempting to send typing indicators to a channel that doesn't support them.

The `login` and `logout` methods are optional because not all channels need interactive authentication. Discord uses a token; WhatsApp needs a QR scan. Channels that don't need interactive auth simply don't implement these methods.

## The Inbound Message Flow

The complete path of an inbound message:

1. Platform event arrives at the channel's Durable Object (WhatsApp WebSocket message, Discord MESSAGE_CREATE).
2. Channel DO parses the platform-specific format into `ChannelInboundMessage` — a normalized structure with peer info, sender info, text, optional media, and metadata.
3. Channel DO calls `env.GATEWAY.channelInbound(channelId, accountId, message)` via Service Binding.
4. The `GatewayEntrypoint` (defined in the Gateway worker's index.ts) receives this and forwards it to the Gateway DO.
5. Gateway DO checks if the sender is allowed (via `allowFrom` lists and pairing).
6. Gateway DO derives the session key from the channel, peer, and dmScope configuration.
7. Gateway DO sends the message to the appropriate Session DO via `chatSend()`.
8. Session DO runs the agent loop, eventually producing a response.
9. Session DO broadcasts the response back through the Gateway.
10. Gateway DO calls `channel.send()` on the appropriate channel worker.
11. Channel worker translates the response to platform format and delivers it.

The Gateway acts as a router in both directions. It never touches platform-specific details — it just passes normalized messages between Sessions and Channels.

## Why Not Just Webhooks?

It's worth addressing this directly. Many messaging bot frameworks use webhooks — HTTP endpoints that receive POSTed events. GSV could have done this: each channel worker exposes a webhook URL, platforms POST events to it, the worker forwards to the Gateway via HTTP.

Service Bindings are better for this use case for several reasons:

- **No public endpoint.** Webhook URLs are public and need authentication, rate limiting, and signature verification. Service Bindings are internal to your Cloudflare account.
- **No HTTP overhead.** Service Binding calls skip HTTP entirely. They're more like local function calls.
- **Type safety.** The interface contract is checked at compile time, not discovered at runtime through URL conventions.
- **Bidirectional by default.** Both sides can call each other. With webhooks, the Gateway would need its own webhook URL for each channel to receive outbound messages.

The main downside is vendor lock-in: Service Bindings are a Cloudflare-specific mechanism. If GSV ever needed to run outside Cloudflare, the channel communication would need to be rearchitected. For now, the benefits outweigh this concern — the entire system is built on Cloudflare primitives, so the channels' use of Service Bindings is consistent rather than anomalous.
