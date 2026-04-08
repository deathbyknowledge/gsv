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
# First-time guided setup (deploy + local node daemon)
gsv setup

# Cloud-only setup (skip local node daemon)
gsv setup --skip-node

# Pin exact CLI release tag (immutable build)
curl -sSL https://install.gsv.space | GSV_VERSION=gsv-stable-1234-abcdef0 bash
```

If you want to configure a different machine after deployment:

```bash
curl -sSL https://install.gsv.space | bash
gsv local-config set gateway.url wss://gsv.<your-domain>.workers.dev/ws
gsv local-config set gateway.username <your-username>
gsv local-config set gateway.token <your-password-or-token> # legacy non-interactive credential field
```

### Chat

```bash
gsv client "Hello, what can you help me with?"
```

### Connect a Node

Nodes give GSV tools to interact with your machines:

```bash
# Already handled by `gsv setup` unless you used --skip-node.
# Manual install/start as a background service:
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

Channel command groups are being redesigned for `gateway`.
For now, deploy channel workers with `gsv deploy up -c ...` and configure behavior through `gsv config`.

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
gsv init                                       # Create local config template
gsv setup [--id ID --workspace DIR]            # First-time setup (deploy + node)
gsv upgrade [--version TAG] [--all]            # Upgrade deployed components
GSV_CHANNEL=dev gsv upgrade --all              # Upgrade from moving dev channel release
gsv local-config set release.channel stable    # Persist default release track for setup/upgrade
gsv uninstall [--delete-bucket]                # Teardown deployment (+ local node by default)
gsv version                                    # Show build/version metadata

# Gateway interaction
gsv client [MESSAGE]                           # Chat (interactive if no message)
gsv shell                                      # Run OS shell commands via shell.exec
gsv config get [KEY]                           # Get remote gateway/kernel config
gsv config set KEY VALUE                       # Set remote gateway/kernel config
gsv proc list|spawn|send|history|reset|kill   # Direct process-management syscalls

# Node
gsv node install --id ID --workspace DIR      # Install/start node daemon
gsv node start|stop|status                    # Manage node daemon
gsv node logs --follow                        # Service logs
gsv node --foreground --id ID --workspace DIR # Run node in foreground

# Local config
gsv local-config show                         # Show local config file values
gsv local-config get KEY              # Get local config
gsv local-config set KEY VALUE        # Set local config
gsv local-config path                         # Show local config path

# Deploy
gsv deploy up|down|status                    # Manage Cloudflare deployment

# Workspace
gsv mount setup                       # Configure R2 mount
gsv mount start                       # Start FUSE mount
gsv mount stop                        # Stop mount
gsv mount status                      # Show mount status
```

Use global `--token` for non-interactive auth (legacy credential flag). Interactive commands can prompt for username/password when running in a TTY.

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
