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
                              │   │  • Tool registry (namespaced)   │   │
                              │   │  • Coordinates channels         │   │
                              │   └──────────────┬──────────────────┘   │
                              │                  │                      │
                              │     ┌────────────┼────────────┐         │
                              │     ▼            ▼            ▼         │
                              │ ┌────────┐  ┌───────��┐  ┌────────┐     │
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
            │ Cloudflare   │           │  macbook:*   │           │  server:*    │
            │ Worker + DO  │           │    tools     │           │    tools     │
            └──────────────┘           └──────────────┘           └──────────────┘
                    │                          │                          │
                    ▼                          ▼                          ▼
              WhatsApp API              Your Laptop               Your Server
                                        (bash, files)            (docker, APIs)
```

## Quick Start

### Install

```bash
curl -sSL https://raw.githubusercontent.com/deathbyknowledge/gsv/main/install.sh | sh
```

This installs the CLI and optionally deploys the gateway to your Cloudflare account.

### Connect a Node

```bash
# Run a node (tools are namespaced by node ID)
gsv node --id macbook --workspace ~/projects

# The gateway sees tools as: macbook:Bash, macbook:Read, macbook:Write, etc.
```

### Chat

```bash
gsv client "Hello, what can you help me with?"
```

### Configure

```bash
# Initialize config file
gsv init

# Set gateway connection
gsv local-config set gateway.url "wss://your-gateway.workers.dev/ws"
gsv local-config set gateway.token "your-secret-token"

# Configure LLM API keys (stored in gateway)
gsv config set apiKeys.anthropic "sk-ant-..."
gsv config set model.provider "anthropic"
gsv config set model.id "claude-sonnet-4-20250514"
```

## Tool Namespacing

Tools are namespaced by node ID, allowing multiple nodes with different capabilities:

```bash
# On your laptop
gsv node --id laptop --workspace ~/code

# On a server
gsv node --id server --workspace /var/app

# The LLM sees:
#   laptop:Bash, laptop:Read, laptop:Write, laptop:Edit, laptop:Glob, laptop:Grep
#   server:Bash, server:Read, server:Write, server:Edit, server:Glob, server:Grep

# And can reason: "I'll check the logs on the server" → uses server:Bash
```

### Test Tools Directly

```bash
# List available tools
gsv tools list

# Call a tool directly
gsv tools call "macbook:Bash" '{"command": "ls -la"}'
gsv tools call "macbook:Read" '{"path": "/etc/hosts"}'
```

## Components

### Gateway (`gateway/`)

The central nervous system. A Cloudflare Worker with Durable Objects that:

- Accepts WebSocket connections from nodes, channels, and clients
- Routes messages between all components
- Maintains a registry of available tools (namespaced by node)
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
gsv node --id macbook                    # Use hostname as ID, cwd as workspace
gsv node --id macbook --workspace ~/dev  # Custom workspace
gsv client "What files are on my desktop?"
gsv session list
gsv session preview my-session
```

### Channels (`channels/`)

Bridges to external messaging platforms:

- **WhatsApp** - Full media support (images, voice messages with transcription)
- *(Planned: Telegram, Discord, Signal)*

Each channel runs as a separate Cloudflare Worker, maintaining its own connection state and routing messages through the Gateway.

## Agent Workspace

GSV agents have persistent identity through workspace files stored in R2:

```
agents/{agentId}/
├── SOUL.md         # Identity and personality
├── USER.md         # Information about the human
├── AGENTS.md       # Operating instructions
├── MEMORY.md       # Long-term curated memory (main sessions only)
├── HEARTBEAT.md    # Proactive check-in configuration
├── TOOLS.md        # Tool-specific notes
├── memory/         # Daily memory files
│   └── YYYY-MM-DD.md
└── skills/         # Available skills
    └── {skillName}/
        └── SKILL.md
```

These files are loaded into the system prompt at session start, giving the agent persistent context across conversations.

### R2 Mount (Optional)

Mount the R2 bucket locally to edit agent config files with your favorite editor:

```bash
# Configure R2 credentials
gsv local-config set r2.account_id "your-account-id"
gsv local-config set r2.access_key_id "your-access-key"
gsv local-config set r2.secret_access_key "your-secret"
gsv local-config set r2.bucket "gsv-storage"

# Setup and start mount
gsv mount setup
gsv mount start

# Edit files locally - changes sync to R2
vim ~/.gsv/r2/agents/main/SOUL.md
```

## CLI Reference

```bash
gsv init                              # Create config file
gsv node [--id ID] [--workspace DIR]  # Run as tool-providing node
gsv client [MESSAGE]                  # Chat (interactive if no message)
gsv tools list                        # List available tools
gsv tools call TOOL [ARGS]            # Call a tool directly
gsv session list                      # List sessions
gsv session preview KEY               # Preview session messages
gsv session reset KEY                 # Clear session history
gsv config get [PATH]                 # Get gateway config
gsv config set PATH VALUE             # Set gateway config
gsv local-config get KEY              # Get local config
gsv local-config set KEY VALUE        # Set local config
gsv mount setup                       # Configure R2 mount
gsv mount start                       # Start R2 FUSE mount
gsv mount stop                        # Stop mount
gsv mount status                      # Check mount status
gsv heartbeat status                  # Check heartbeat scheduler
gsv pair list                         # List pending pairing requests
gsv pair approve CHANNEL SENDER       # Approve a sender
```

## Project Status

GSV is under active development. Current capabilities:

- [x] Gateway and Session Durable Objects
- [x] Multi-provider LLM support (Anthropic, OpenAI, Google)
- [x] Rust CLI (node mode, client mode)
- [x] Tool execution across nodes (Bash, Read, Write, Edit, Glob, Grep)
- [x] Tool namespacing by node ID
- [x] Session management (list, preview, reset, archive)
- [x] WhatsApp channel with media support
- [x] Voice message transcription (Workers AI)
- [x] R2 media storage
- [x] Agent workspace (SOUL.md, USER.md, AGENTS.md, MEMORY.md)
- [x] Skills system (on-demand capability loading)
- [x] R2 FUSE mount for local config editing
- [x] Heartbeat/proactive behavior
- [x] Typing indicators
- [ ] Web client
- [ ] Telegram channel
- [ ] Memory/vector search
- [ ] Multi-agent coordination
- [ ] Node daemon mode

## Development

```bash
# Gateway
cd gateway
npm install
npm run dev          # Local development with wrangler
npm run deploy       # Deploy to Cloudflare

# CLI
cd cli
cargo build --release
cargo test

# WhatsApp Channel
cd channels/whatsapp
npm install
npm run dev
npm run deploy
```

## Philosophy

Traditional AI assistants are stateless - each conversation starts fresh, each request is isolated. GSV takes a different approach: your AI is a persistent entity that exists in the cloud, remembers your conversations, and can act on your behalf across all your devices.

Like a Culture Mind, it's not just a tool you invoke - it's an intelligence that persists, learns, and operates as part of your extended self. The ephemeral nature of cloud computing becomes a feature: your AI exists everywhere and nowhere, spawning instances across the globe as needed, hibernating when idle, always ready to wake.

## License

MIT

---

*"Outside Context Problem: The sort of thing most civilizations encounter just once, and which they tended to encounter rather in the same way a sentence encounters a full stop."* — Iain M. Banks
