# GSV
![gsv](https://github.com/user-attachments/assets/2b51a9e7-27be-4c8c-a234-7cf8f4dfb218)
> ***A distributed operating system for humans, machines, and agents.***

Imagine a personal cloud computer where AI is built directly into the kernel. **GSV (General Systems Vehicle)** unifies your laptops, servers, and phones into a single cohesive system where agents operate as native background processes.

Named after the planet-scale sentient ships from Iain M. Banks' *Culture* series, GSV provides the foundation for self-aware personal AI that lives, breathes, and spawns across the edge of the internet.

> [!NOTE]
> **GSV is actively baking! 🏗️**
> We are polishing the final touches for our official beta launch in the upcoming weeks. We believe in transparent, open-source development, so you are incredibly welcome to deploy it and play with it exactly as it is today. Expect rapid changes, a few broken wires, and frequent updates!

## What can GSV do?

- **Treat Agents like Linux Processes** - Agents have identities, durable history, permissions, and a syscall surface. You can spawn, kill, and manage them just like traditional OS processes.
- **Unify Your Hardware** - Connect your Macbook, Linux server, or phone. Your agents can securely reach your devices, use the shell, and read/write files from anywhere on Earth or beyond.
- **Communicate Natively** - Talk to your agents via the built-in Web UI, the command-line interface, or bridge them to external channels like WhatsApp and Discord.
- **A Self-Hosting Ecosystem** - Write native apps with the GSV SDK and distribute them via the built-in git remote. Because agents can own repositories and host their own packages, GSV functions as a distributed, peer-to-peer app store.

## Documentation
- [Documentation page](https://gsv.space/)
- [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/deathbyknowledge/gsv)

## 🤝 Get Involved

GSV is actively evolving, and we want you to be part of the network! We welcome contributions of all sizes.
Whether you want to submit a pull request, share a wild idea, or just say hi, please don't hesitate to reach out. :)

- **Join the Community:** Come hang out, talk shop, and share ideas on our [Discord Server](https://discord.gg/hy9ExJJFvn).
- **Found a bug or have a feature request?** - [Open an issue](https://github.com/deathbyknowledge/gsv/issues).
- **Follow Updates:** Reach out directly on Twitter/X: [@deathbyknowledg](https://x.com/deathbyknowledg) or [@humachinesinc](https://x.com/humachinesinc)
- **Direct Feedback & Support:** Of course, you can also just email us at **[hello@humansandmachin.es]** to share your thoughts or get help.

## Quick Start

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (Workers Paid plan required)

### Deploy

```sh
# Installs CLI
curl -sSL https://install.gsv.space | bash
# Deploys all components to your Cloudflare account
gsv infra deploy --api-token <CLOUDFLARE-API-TOKEN>
# For a second install in the same account, add a unique instance prefix:
gsv infra deploy --instance gsv-personal --api-token <CLOUDFLARE-API-TOKEN>
```

Once the deployment finishes, open the URL to finish your onboarding through the Web UI.

### Chat

You can interact with any of the Agent processes in your GSV in multiple ways:

- Through the built-in **Chat** app in the web UI
- By messaging through any connected adapter, such as WhatsApp, Discord, or Telegram
- Or through the CLI directly:

```bash
gsv chat "Hello, what can you help me with?"
```

### Connect a Device
Devices connected to your GSV user are reachable by your agents from anywhere on Earth.

Easily add a device through **GSV > Devices** in the Web UI or do it directly from the CLI:

```bash
# Create a token for the device (make a note of it)
gsv auth token create --device macbook --label Macbook
# Set the token
gsv config --local set node.token <token>
# Manual install/start as a background service:
gsv device install --id macbook --workspace ~/

# Check status/logs
gsv device status
gsv device logs --follow

# Instead of a background service you can run it in the foreground:
gsv device run --id macbook --workspace ~/projects
```

Node logs are structured JSON at `~/.gsv/logs/node.log` with app-side rotation
(default: 10MB, 5 files). Override with `GSV_NODE_LOG_MAX_BYTES` and
`GSV_NODE_LOG_MAX_FILES`.

Now GSV can use the shell, read and write files on your machine.

## Adapters

The easiest way to set up adapters is through **GSV > Integrations** in the Web UI.

## Components

- **Gateway** - Central brain running on Cloudflare, serves as the OS kernel. Manages auth, filesystem state, routing, and exposes system calls that processes and apps use to access GSV capabilities.
- **Processes** - Each agent is a process in the GSV OS with persistent history and its own agent loop.
- **Devices** - Your devices connected to GSV, providing remote tool access (Bash, Read, Write, Edit, Search).
- **Adapters** - Bridges to WhatsApp, Discord, Telegram, etc. Each runs as a separate Worker.

## Development

### Prerequisites

- [Rust](https://rustup.rs) (for CLI)
- [Node.js + npm](https://nodejs.org) (for package installation)

```bash
# Install JS deps across the workspace, adapters, and ripgit
./scripts/setup-deps.sh

# Start the local multi-worker development stack
npm run dev

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

![gsv](https://github.com/user-attachments/assets/dba02d8f-3a3a-40c5-b38f-5eea3b2ea99d)
