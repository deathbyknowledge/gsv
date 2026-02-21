# GSV
![gsv](https://github.com/user-attachments/assets/dba02d8f-3a3a-40c5-b38f-5eea3b2ea99d)
**GSV** (General Systems Vehicle) is a distributed AI agent platform built on Cloudflare's global infrastructure. Named after the planet-scale sentient ships from Iain M. Banks' Culture series, GSV provides a foundation for personal AI that exists as ephemeral beings spawning across the earth's edge network.

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/deathbyknowledge/gsv)
## Quick Start

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works :D)

### Deploy

```bash
# Installs CLI
curl -sSL https://install.gsv.space | bash

# https://dash.cloudflare.com/profile/api-tokens Use "Edit Cloudflare Workers" template
# First-time guided deploy
gsv deploy up --wizard
```

If you want to configure a different machine after deployment:

```bash
curl -sSL https://install.gsv.space | bash
gsv local-config set gateway.url wss://gsv.<your-domain>.workers.dev/ws
gsv local-config set gateway.token <your-auth-token> # you can always get it with `gsv config get auth.token`
```

### Chat

```bash
gsv client "Hello, what can you help me with?"
```

### Connect a Node

Nodes give GSV tools to interact with your machines:

```bash
# Recommended: install node as a background service
gsv node install --id macbook --workspace ~/projects

# Check status/logs
gsv node status
gsv node logs --follow

# Foreground mode (manual, useful for debugging)
gsv node --foreground --id macbook --workspace ~/projects
```

Node logs are structured JSON at `~/.gsv/logs/node.log` with app-side rotation
(default: 10MB, 5 files). Override with `GSV_NODE_LOG_MAX_BYTES` and
`GSV_NODE_LOG_MAX_FILES`.

Now GSV can run bash commands, read/write files, and search code on your laptop.

### Channels

Connect messaging apps during the wizard or later:

```bash
gsv channel whatsapp login    # Scan QR code
gsv channel discord start     # Start Discord bot
```

> [!NOTE]
> Both WhatsApp and Discord channels require an always-on Durable Object to run. While the Workers free tier fits 1 always-on DO, having multiple channels or multiple accounts in a single channel will require a paid plan (or you'll experience downtime).


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
                    │   │  • Spawns agents autonomously   │   │
                    │   └──────────────┬──────────────────┘   │
                    │                  │                      │
                    │     ┌────────────┼────────────┐         │
                    │     ▼            ▼            ▼         │
                    │ ┌────────┐  ┌────────┐  ┌────────┐      │
                    │ │Session │  │Session │  │Session │      │
                    │ │  DO    │  │  DO    │  │  DO    │      │
                    │ │        │  │        │  │        │      │
                    │ │ wa:dm  │  │ tg:grp │  │ cli:me │      │
                    │ └────────┘  └────────┘  └────────┘      │
                    │                                         │
                    │            R2 Storage                   │
                    │     (media, archives, config)           │
                    └────────────────┬────────────────────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
          ▼                          ▼                          ▼
  ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
  │   Channel    │           │    Node      │           │    Client    │
  │  (WhatsApp)  │           │  (macbook)   │           │ (CLI/WebUI)  │
  │              │           │              │           │              │
  │ Cloudflare   │           │  macbook:*   │           │              │
  │ Worker + DO  │           │    tools     │           │              │
  └──────────────┘           └──────────────┘           └──────────────┘
          │                          │                          │
          ▼                          ▼                          ▼
    WhatsApp API              Your Laptop             Send messages, configure
                              (bash, files)            gateway, etc.
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
gsv node install --id laptop --workspace ~/code

# On a server  
gsv node install --id server --workspace /var/app

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

## CLI Reference

```bash
# Core
gsv client [MESSAGE]                  # Chat (interactive if no message)
gsv node install --id ID --workspace DIR      # Install/start node daemon
gsv node start|stop|status                    # Manage node daemon
gsv node logs --follow                        # Service logs
gsv node --foreground --id ID --workspace DIR # Run node in foreground

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

# Access control
gsv pair list                         # List pending pair requests
gsv pair approve CHANNEL SENDER       # Approve a sender

# Tools
gsv tools list                        # List available tools
gsv tools call TOOL ARGS              # Call tool directly

# Workspace
gsv mount setup                       # Configure R2 mount
gsv mount start                       # Start FUSE mount
gsv mount stop                        # Stop mount
```

## Development

### Prerequisites

- [Rust](https://rustup.rs) (for CLI)
- [Node.js + npm](https://nodejs.org) (for package installation)

```bash
# Install JS deps across gateway + channels
./scripts/setup-deps.sh

# Gateway dev
cd gateway && npm run dev

# CLI
cd cli && cargo build --release

# Build local Cloudflare bundles and deploy via CLI
./scripts/build-cloudflare-bundles.sh
gsv deploy up --bundle-dir ./release/local --version local-dev --all --force-fetch

# Local-bundle deploy shortcut (defaults to `-c gateway`)
./scripts/deploy-local.sh
./scripts/deploy-local.sh -c gateway --force-fetch
```

## License

MIT

---

*"Outside Context Problem: The sort of thing most civilizations encounter just once, and which they tended to encounter rather in the same way a sentence encounters a full stop."* — Iain M. Banks
