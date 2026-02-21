# Architecture Overview

GSV is named after the General Systems Vehicles from Iain M. Banks' Culture series — planet-scale sentient ships that carry entire civilizations within them, coordinating billions of activities while maintaining a singular identity. The name is aspirational rather than literal, but it captures something true about the design intent: a single distributed intelligence that spans multiple machines and communication channels, maintaining coherent identity across all of them.

This document explains why GSV is built the way it is, how the pieces connect, and what trade-offs that architecture implies.

## The Three Pillars

GSV's architecture rests on three distinct component types, each with a clear role:

**The Gateway** is the brain. It runs on Cloudflare's edge network as a Worker with Durable Objects. It holds configuration, routes messages, manages the tool registry, coordinates channels, and spawns agent sessions. There is exactly one Gateway Durable Object instance — a singleton — which acts as the central coordination point for the entire system. Every message, every tool call, every configuration change flows through this single point.

**Nodes** are the hands. They are machines running the Rust CLI in node mode, providing tools that let the agent interact with the physical world — running shell commands, reading and writing files, searching codebases. A laptop, a server, a Raspberry Pi — any machine can be a node. Multiple nodes can connect simultaneously, each offering its own set of tools namespaced by its ID.

**Channels** are the senses. They are separate Cloudflare Workers that bridge external messaging platforms — WhatsApp, Discord, and potentially others — into the GSV ecosystem. Each channel translates platform-specific protocols (WhatsApp's Baileys WebSocket, Discord's Gateway API) into GSV's uniform message format.

This separation is deliberate. The brain doesn't need to know how WhatsApp authentication works, and the hands don't need to know which channel a message came from. Each pillar has a single responsibility, and the interfaces between them are narrow and well-defined.

The Gateway also serves as a relay for file transfers between nodes. The `gsv__Transfer` tool moves files between any combination of node filesystems and R2 workspace storage. Data flows as binary WebSocket frames alongside the normal JSON text frames, using a 4-byte transfer ID prefix for demultiplexing. This allows the agent to coordinate work across machines — pulling build artifacts from a CI server to a development laptop, or archiving files from a node into the R2 workspace.

## Why Cloudflare Workers and Durable Objects?

This is probably the most important architectural decision in GSV, and it's worth understanding why.

The alternative would have been a traditional server — a VPS running Node.js, a container on AWS, a Kubernetes pod. That's the obvious path. But GSV chose Cloudflare Workers for several interconnected reasons:

**No server to maintain.** GSV is designed as personal AI infrastructure. The target user doesn't want to babysit a server, worry about uptime, manage SSL certificates, or handle OS updates. Workers run on Cloudflare's edge network with zero infrastructure management. You deploy, and it works. This matters enormously for a system that's meant to be always-available — your AI agent shouldn't go offline because you forgot to renew a domain or a VPS ran out of disk.

**Global edge deployment.** Workers run in over 300 data centers worldwide. When you send a WhatsApp message to your agent from Tokyo, the Gateway Worker spins up at the nearest edge location. This isn't just about latency — it's about the system being genuinely available everywhere, like a phone number rather than a website.

**Durable Objects solve the state problem.** Serverless functions are stateless by nature, but an AI agent is fundamentally stateful — it has conversation history, configuration, pending tool calls, heartbeat schedules. Durable Objects provide strongly consistent, single-threaded state machines that live on the edge. The Gateway DO maintains WebSocket connections, the tool registry, and routing tables. Session DOs maintain per-conversation message history in SQLite and manage the agent loop lifecycle.

**Hibernation.** This is subtle but important. Durable Objects can hibernate — they persist their state and release compute resources, then wake up when needed. A Session DO that hasn't received a message in hours isn't consuming any resources. It just has state sitting in storage, waiting. When a message arrives, the DO wakes, rehydrates its WebSocket connections, and picks up exactly where it left off. This is what allows GSV to maintain hundreds of sessions without scaling concerns.

**The cost model works.** Cloudflare's free tier includes Durable Objects, R2 storage, and Workers. For a personal AI agent with moderate usage, the entire infrastructure can run at zero cost. This removes one of the biggest barriers to adoption.

The trade-off is real, though. Workers have execution time limits (30 seconds on the free tier, though Durable Objects get longer). The agent loop must be designed around hibernation — you can't just hold a loop open indefinitely. Tool calls are dispatched, the DO sets an alarm, and it may hibernate while waiting for results. This constraint shaped the entire Session DO design.

## Gateway DO: The Singleton Orchestrator

The Gateway is instantiated as a singleton — `env.GATEWAY.idFromName("singleton")`. Every WebSocket connection, every RPC call, every channel event routes through this single instance. This might seem like a bottleneck, and in a system serving thousands of users it would be. But GSV is personal infrastructure. One person, one Gateway, many sessions.

The singleton pattern buys something valuable: a single authoritative view of the world. The Gateway knows exactly which nodes are connected and what tools they provide. It knows which channels are active. It knows every pending tool call and can route results back to the correct session. There's no distributed consensus problem, no cache invalidation, no split-brain scenario. The trade-off of single-point-of-failure is acceptable because Cloudflare's infrastructure handles the availability concern at the platform level.

The Gateway maintains several key registries as persisted state:

- **Tool Registry**: maps node IDs to their tool definitions. When a node connects, it registers its tools. When it disconnects, the registry is cleaned up.
- **Session Registry**: tracks active sessions and their metadata.
- **Channel Registry**: tracks connected channel workers.
- **Config Store**: holds the global GSV configuration (model settings, API keys, channel config, heartbeat settings).
- **Pending Tool Calls**: tracks in-flight tool dispatches, linking call IDs to their originating sessions or clients.

All of these use `PersistedObject`, a utility that wraps Durable Object KV storage with a Proxy-based API that makes reads/writes look like plain object property access while automatically persisting changes. This is essential for hibernation — the state survives DO eviction without explicit save calls.

## Session DOs: Per-Conversation State Machines

While the Gateway is a singleton, Sessions are many. Each conversation — identified by a session key like `agent:main:cli:dm:main` or `agent:main:whatsapp:dm:+1234567890` — gets its own Durable Object instance. The session key is the DO's name, so the mapping is deterministic: the same conversation always maps to the same DO.

A Session DO is a state machine with a clear lifecycle:

1. **Idle**: No active run. Messages in SQLite. Waiting for input.
2. **Processing**: A run is active. The agent loop is calling LLMs and dispatching tools.
3. **Waiting**: Tools have been dispatched. The DO may hibernate with an alarm set for timeout. It will wake when tool results arrive.

Messages are stored in SQLite (provided by Durable Objects), not KV. This is a deliberate choice — SQLite supports ordered queries, counting, and bulk operations that are awkward with KV. The conversation history is the Session's primary data structure, and SQLite handles it well.

The Session doesn't maintain WebSocket connections of its own. It communicates with the outside world through the Gateway. When the Session has a response to broadcast, it calls back to the Gateway DO, which routes the message to the appropriate clients and channels. This indirection keeps the Session focused on its core concern: running the agent loop.

## How Everything Connects

The flow of a typical message through the system:

```
User types in CLI
  → CLI sends WebSocket frame to Gateway Worker
    → Worker routes to Gateway DO (singleton)
      → Gateway resolves session key, calls Session DO
        → Session builds system prompt from R2 workspace files
        → Session calls LLM provider (Anthropic, OpenAI, etc.)
        → LLM responds with tool calls
          → Session asks Gateway to dispatch tools
            → Gateway finds the right node, sends WebSocket event
              → Node executes tool (Bash, Read, etc.)
              → Node sends result back via WebSocket
            → Gateway routes result to Session
          → Session feeds result back to LLM
          → LLM produces final response
        → Session broadcasts response via Gateway
      → Gateway sends to connected clients/channels
    → CLI displays response
```

For channel messages, the flow is slightly different at the edges. A WhatsApp message arrives at the WhatsApp Channel Worker, which calls `GatewayEntrypoint.channelInbound()` via Service Binding. The Gateway determines the session key from the sender's identity and peer context, then the rest flows identically. The response travels back through the Gateway, which calls `channel.send()` on the appropriate channel worker.

## R2: The Persistent Memory Layer

Cloudflare R2 serves as GSV's long-term storage, organized under a single bucket:

```
agents/{agentId}/
  SOUL.md           - Core personality and values
  IDENTITY.md       - Name, emoji, profile
  USER.md           - Information about the human
  AGENTS.md         - Operating instructions
  MEMORY.md         - Long-term persistent memory
  TOOLS.md          - Tool usage notes
  HEARTBEAT.md      - Heartbeat behavior config
  BOOTSTRAP.md      - First-run commissioning (deleted after use)
  memory/YYYY-MM-DD.md  - Daily memory extractions
  sessions/{id}.jsonl.gz - Archived conversation transcripts
  skills/{name}/SKILL.md - Agent-specific skill overrides
```

These files serve dual purposes. They're loaded into the system prompt to give the agent its identity and context. But they're also writable — the agent can update its own MEMORY.md, modify its SOUL.md, or create daily memory files. This is what makes the agent persistent across conversations. When a session is reset, the conversation history is archived, but the workspace files remain. The agent "remembers" through its workspace, not through its conversation buffer.

The R2 layout also supports multiple agents. Each agent gets its own workspace under `agents/{agentId}/`. The default agent is "main", but you could have "work", "personal", "research" — each with different personalities, memories, and operating instructions, all running on the same Gateway.

## Why Distributed Instead of Monolithic?

One could imagine a simpler architecture: a single binary that runs on your laptop, includes the LLM client, the WhatsApp bridge, and the tool execution, all in one process. Why didn't GSV do that?

The answer is availability. A personal AI agent that only works when your laptop is open and connected to the internet isn't very useful. WhatsApp messages arrive at 3 AM. Discord pings come while you're on a plane. The agent needs to be reachable even when no physical machine is available.

The Gateway runs on Cloudflare's always-on infrastructure. It can receive messages, interact with the LLM, and respond — even with no nodes connected. It can't run Bash commands or read files without a node, but it can carry on conversations, access its R2 workspace, use native tools (workspace file read/write), and schedule tasks.

When a node does connect, the agent gains access to that machine's tools. When it disconnects, the agent gracefully degrades — it knows which tools it has and doesn't try to use ones that aren't available. Multiple nodes can connect simultaneously, and the agent can reason about which node to use for a given task based on the namespaced tool names ("I'll check the logs on the server, then edit the code on the laptop").

This is the Culture ship analogy in practice. The ship's Mind (Gateway) thinks independently. Its drones and avatars (Nodes) extend its reach into the physical world. Its communication arrays (Channels) let it talk to anyone, anywhere. Remove a drone, and the Mind still thinks. Add a new communication channel, and the Mind can immediately use it. The architecture mirrors the metaphor.
