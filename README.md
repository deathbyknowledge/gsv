# GSV
![gsv](https://github.com/user-attachments/assets/dba02d8f-3a3a-40c5-b38f-5eea3b2ea99d)
**GSV** (General Systems Vehicle) is a distributed AI agent platform built on Cloudflare's global infrastructure. Named after the planet-scale sentient ships from Iain M. Banks' Culture series, GSV provides a foundation for personal AI that exists as ephemeral beings spawning across the earth's edge network.

## The Vision

In Banks' universe, a General Systems Vehicle is a vast spacecraft - kilometers long, home to millions of inhabitants - that functions as a self-contained civilization. Each GSV has a **Mind**: a hyperintelligent AI that manages the ship's systems while drones, humans, and smaller vessels operate within its embrace.

GSV the platform mirrors this architecture:

- **The Mind** (Gateway + Sessions) - Central intelligence running in the cloud, maintaining context and coordinating action
- **Drones** (Nodes) - Your devices: laptops, phones, servers - each contributing capabilities to the collective
- **Channels** - Communication interfaces to the outside world: WhatsApp, Telegram, web interfaces
- **Sessions** - Individual relationships and conversations, each with their own memory and personality

Unlike traditional AI assistants that exist only as stateless API calls, GSV agents are persistent entities. They remember. They can reach out through your phone, execute code on your laptop, and maintain conversations across months - all while existing as distributed processes that hibernate when idle and wake across Cloudflare's global network.

## Architecture

```
                              ┌─────────────────────────────────────────┐
                              │              THE CLOUD                  │
                              │         (Cloudflare Edge)               │
                              │                                         │
                              │   ┌─────────────────────────────────┐   │
                              │   │         Gateway DO              │   │
                              │   │    (singleton Mind core)        │   │
                              │   │                                 │   │
                              │   │  • Routes messages              │   │
                              │   │  • Manages tool registry        │   │
                              │   │  • Coordinates channels         │   │
                              │   └──────────────┬──────────────────┘   │
                              │                  │                      │
                              │     ┌────────────┼────────────┐         │
                              │     ▼            ▼            ▼         │
                              │ ┌────────┐  ┌────────┐  ┌────────┐     │
                              │ │Session │  │Session │  │Session │     │
                              │ │  DO    │  │  DO    │  │  DO    │     │
                              │ │        │  │        │  │        │     │
                              │ │ wa:dm  │  │ tg:grp │  │ cli:me │     │
                              │ └────────┘  └────────┘  └────────┘     │
                              │                                         │
                              │            R2 Storage                   │
                              │     (media, archives, config)           │
                              └────────────────┬────────────────────────┘
                                               │
                    ┌──────────────────────────┼──────────────────────────┐
                    │                          │                          │
                    ▼                          ▼                          ▼
            ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
            │   Channel    │           │    Node      │           │    Node      │
            │  (WhatsApp)  │           │  (macbook)   │           │   (server)   │
            │              │           │              │           │              │
            │ Cloudflare   │           │    Rust      │           │    Rust      │
            │ Worker + DO  │           │    CLI       │           │    CLI       │
            └──────────────┘           └──────────────┘           └──────────────┘
                    │                          │                          │
                    ▼                          ▼                          ▼
              WhatsApp API              Your Laptop               Your Server
                                        (bash, files)            (docker, APIs)
```

## Components

### Gateway (`gateway/`)

The central nervous system. A Cloudflare Worker with Durable Objects that:

- Accepts WebSocket connections from nodes, channels, and clients
- Routes messages between all components
- Maintains a registry of available tools across connected nodes
- Manages configuration and authentication
- Stores media in R2

### Sessions

Each conversation exists as its own Durable Object with:

- Persistent message history (SQLite)
- Isolated state that survives hibernation
- Its own agent loop calling LLMs (Anthropic, OpenAI, Google)
- Tool execution coordination

### Nodes (`cli/`)

A Rust CLI that connects your devices to the GSV:

```bash
# Connect your laptop as a node
gsv node --id macbook

# Send a message
gsv client "What files are on my desktop?"

# Manage sessions
gsv session list
gsv session preview my-session
```

Nodes provide tools (bash, file operations, etc.) that the AI can use.

### Channels (`channels/`)

Bridges to external messaging platforms:

- **WhatsApp** - Full media support (images, voice messages with transcription)
- *(Planned: Telegram, Discord, Signal)*

Each channel runs as a separate Cloudflare Worker, maintaining its own connection state and routing messages through the Gateway.

## Quick Start

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) with Workers paid plan
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- [Rust](https://rustup.rs/) (for the CLI)

### Deploy the Gateway

```bash
cd gateway
npm install
npm run deploy
```

### Build the CLI

```bash
cd cli
cargo build --release
```

### Connect a Node

```bash
./target/release/gsv node --id my-laptop \
  --url wss://your-gateway.workers.dev/ws \
  --token YOUR_AUTH_TOKEN
```

### Configure

Set your API keys and auth token via the CLI:

```bash
# Set auth token (required for all operations)
gsv config set auth.token "your-secret-token"

# Set LLM API keys
gsv config set apiKeys.anthropic "sk-ant-..."
gsv config set apiKeys.openai "sk-..."  # optional

# Set default model
gsv config set model.provider "anthropic"
gsv config set model.id "claude-sonnet-4-20250514"
```

Configuration is stored in the Gateway's Durable Object storage - no Worker secrets needed.

### Chat

```bash
./target/release/gsv client "Hello, what can you help me with?"
```

## Protocol

GSV uses a simple JSON-RPC-like protocol over WebSocket:

```typescript
// Request
{ "type": "req", "id": "uuid", "method": "chat.send", "params": { "message": "..." } }

// Response  
{ "type": "res", "id": "uuid", "ok": true, "payload": { ... } }

// Event (streaming)
{ "type": "evt", "event": "chat", "payload": { "state": "partial", "message": "..." } }
```

See [SPEC.md](./SPEC.md) for full protocol documentation.

## Agent Workspace

GSV agents have persistent identity through workspace files stored in R2. The workspace contains:

```
agents/{agentId}/
├── SOUL.md         # Identity and personality
├── USER.md         # Information about the human
├── AGENTS.md       # Operating instructions
├── MEMORY.md       # Long-term curated memory (main sessions only)
├── TOOLS.md        # Tool-specific notes
├── memory/         # Daily memory files
│   └── YYYY-MM-DD.md
└── skills/         # Available skills
    └── {skillName}/
        └── SKILL.md
```

These files are loaded into the system prompt at session start, giving the agent persistent context across conversations.

### Local Workspace Mount (R2 FUSE)

For CLI nodes, you can mount the R2 workspace locally so the agent can read/write files naturally:

```bash
# 1. Install rclone (FUSE filesystem tool)
brew install rclone         # macOS
# or: curl https://rclone.org/install.sh | sudo bash  # Linux

# 2. Create R2 API token in Cloudflare Dashboard:
#    - Go to R2 > Manage R2 API Tokens
#    - Create token with "Object Read & Write" permissions
#    - Note: Account ID, Access Key ID, Secret Access Key

# 3. Configure the mount
gsv mount setup \
  --account-id YOUR_CF_ACCOUNT_ID \
  --access-key-id YOUR_R2_ACCESS_KEY \
  --secret-access-key YOUR_R2_SECRET

# 4. Start the mount
gsv mount start

# 5. Verify
ls ~/gsv/  # Should show SOUL.md, USER.md, etc.
```

Now when the agent uses file tools (Read, Write, Edit), it operates on your local filesystem which syncs transparently to R2. Other channels (WhatsApp, etc.) see the same files.

### Environment Variables

```bash
export GSV_WORKSPACE=~/gsv           # Workspace path (default: ~/gsv)
export GSV_TOKEN=your-auth-token     # Gateway auth token
export CF_ACCOUNT_ID=your-account    # For R2 mount
export R2_ACCESS_KEY_ID=your-key     # For R2 mount  
export R2_SECRET_ACCESS_KEY=secret   # For R2 mount
```

## Skills

Skills are on-demand capabilities defined in markdown files. The agent sees a list of available skills and reads the full instructions when needed.

Example skill (`agents/main/skills/memory-update/SKILL.md`):

```markdown
---
name: memory-update
description: Update long-term memory with important information
always: false
---

# Memory Update

Use this skill when the user asks you to remember something...

## How to Use
1. Read existing MEMORY.md
2. Append new information to appropriate section
3. Confirm to user what you remembered
```

Skills are loaded from:
1. Agent workspace: `agents/{agentId}/skills/*/SKILL.md`
2. Global skills: `skills/*/SKILL.md`

Agent-specific skills take precedence over global skills with the same name.

## Project Status

GSV is under active development. Current capabilities:

- [x] Gateway and Session Durable Objects
- [x] Multi-provider LLM support (Anthropic, OpenAI, Google)
- [x] Rust CLI (node mode, client mode)
- [x] Tool execution across nodes (Bash, Read, Write, Edit, Glob, Grep)
- [x] Session management (list, preview, reset, archive)
- [x] WhatsApp channel with media support
- [x] Voice message transcription (Workers AI)
- [x] R2 media storage
- [x] Agent workspace (SOUL.md, USER.md, AGENTS.md, MEMORY.md)
- [x] Skills system (on-demand capability loading)
- [x] R2 FUSE mount for local workspace sync
- [ ] Web client
- [ ] Telegram channel
- [ ] Memory/vector search
- [ ] Multi-agent coordination
- [ ] Heartbeat/proactive behavior

## Development

```bash
# Gateway
cd gateway
npm run dev          # Local development
npm run deploy       # Deploy to Cloudflare

# CLI
cd cli
cargo build --release
cargo test

# WhatsApp Channel
cd channels/whatsapp
npm run dev
npm run deploy
```

See [AGENTS.md](./AGENTS.md) for detailed development guidelines.

## Philosophy

Traditional AI assistants are stateless - each conversation starts fresh, each request is isolated. GSV takes a different approach: your AI is a persistent entity that exists in the cloud, remembers your conversations, and can act on your behalf across all your devices.

Like a Culture Mind, it's not just a tool you invoke - it's an intelligence that persists, learns, and operates as part of your extended self. The ephemeral nature of cloud computing becomes a feature: your AI exists everywhere and nowhere, spawning instances across the globe as needed, hibernating when idle, always ready to wake.

## License

MIT

---

*"Outside Context Problem: The sort of thing most civilizations encounter just once, and which they tended to encounter rather in the same way a sentence encounters a full stop."* — Iain M. Banks
