# GSV
![gsv](https://github.com/user-attachments/assets/dba02d8f-3a3a-40c5-b38f-5eea3b2ea99d)
**GSV** (General Systems Vehicle) is a distributed AI agent platform built on Cloudflare's global infrastructure. Named after the planet-scale sentient ships from Iain M. Banks' Culture series, GSV provides a foundation for personal AI that exists as ephemeral beings spawning across the earth's edge network.

## Quick Start

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Rust](https://rustup.rs) (for CLI)
- [Bun](https://bun.sh) (for deployment)

### Deploy

```bash
git clone https://github.com/deathbyknowledge/gsv
cd gsv/gateway
bun install

# Run the deployment wizard
bun alchemy/wizard/bin.ts
```

The wizard will:
1. Ask for your LLM provider and API key
2. Deploy Gateway and channels to Cloudflare
3. Configure everything automatically
4. Install the CLI

### Chat

```bash
gsv client "Hello, what can you help me with?"
```

### Connect a Node

Nodes give GSV tools to interact with your machines:

```bash
gsv node --id macbook --workspace ~/projects
```

Now GSV can run bash commands, read/write files, and search code on your laptop.

### Channels

Connect messaging apps during the wizard or later:

```bash
gsv channel whatsapp login    # Scan QR code
gsv channel discord start     # Start Discord bot
```

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
            │ Cloudflare   │           │  macbook:*   │           │  server:*    │
            │ Worker + DO  │           │    tools     │           │    tools     │
            └──────────────┘           └──────────────┘           └──────────────┘
                    │                          │                          │
                    ▼                          ▼                          ▼
              WhatsApp API              Your Laptop               Your Server
                                        (bash, files)            (docker, APIs)
```

### Components

- **Gateway** - Central brain running on Cloudflare. Routes messages, manages tools, stores config.
- **Sessions** - Each conversation is a Durable Object with persistent history and its own agent loop.
- **Nodes** - Your devices running the CLI, providing tools (Bash, Read, Write, Edit, Glob, Grep).
- **Channels** - Bridges to WhatsApp, Discord, etc. Each runs as a separate Worker.

## Tool Namespacing

Multiple nodes can connect with different capabilities:

```bash
# On your laptop
gsv node --id laptop --workspace ~/code

# On a server  
gsv node --id server --workspace /var/app

# GSV sees: laptop__Bash, laptop__Read, server__Bash, server__Read, etc.
# And can reason: "I'll check the logs on the server" → uses server__Bash
```

## Agent Workspace

GSV agents have persistent identity through workspace files in R2:

```
agents/{agentId}/
├── SOUL.md         # Identity and personality
├── USER.md         # Information about the human
├── AGENTS.md       # Operating instructions
├── MEMORY.md       # Long-term memory
└── HEARTBEAT.md    # Proactive check-in config
```

Edit these locally by mounting R2:

```bash
gsv mount setup && gsv mount start
vim ~/.gsv/r2/agents/main/SOUL.md
```

## CLI Reference

```bash
# Core
gsv client [MESSAGE]                  # Chat (interactive if no message)
gsv node --id ID --workspace DIR      # Run as tool-providing node

# Sessions
gsv session list                      # List sessions
gsv session preview KEY               # Preview messages
gsv session reset KEY                 # Clear history

# Config
gsv config get [PATH]                 # Get gateway config
gsv config set PATH VALUE             # Set gateway config
gsv local-config get KEY              # Get local config
gsv local-config set KEY VALUE        # Set local config

# Channels
gsv channel whatsapp login            # Connect WhatsApp
gsv channel whatsapp logout           # Disconnect
gsv channel discord start             # Start Discord bot
gsv channel discord stop              # Stop bot

# Tools
gsv tools list                        # List available tools
gsv tools call TOOL ARGS              # Call tool directly

# Workspace
gsv mount setup                       # Configure R2 mount
gsv mount start                       # Start FUSE mount
gsv mount stop                        # Stop mount

# Access control
gsv pair list                         # List pending pair requests
gsv pair approve CHANNEL SENDER       # Approve a sender
```

## Development

```bash
# Gateway
cd gateway && npm install && npm run dev

# CLI
cd cli && cargo build --release

# Deploy manually
cd gateway && npm run deploy
```

## Security

GSV is designed for personal use. By default:
- Auth token required for all connections
- WhatsApp uses "pairing" mode - unknown senders need approval
- API keys stored in Cloudflare secrets

See [Security docs](https://github.com/deathbyknowledge/gsv#security) for details.

## License

MIT

---

*"Outside Context Problem: The sort of thing most civilizations encounter just once, and which they tended to encounter rather in the same way a sentence encounters a full stop."* — Iain M. Banks
