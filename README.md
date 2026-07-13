# GSV

![gsv](https://github.com/user-attachments/assets/e50a394b-e568-4306-bb48-e3b532c01eda)

> ***a mind for your machines***

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/deathbyknowledge/gsv)](https://github.com/deathbyknowledge/gsv/releases)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/hy9ExJJFvn)
[![X](https://img.shields.io/badge/X-@gsvspace-000?logo=x&logoColor=white)](https://x.com/gsvspace)
[![Docs](https://img.shields.io/badge/docs-gsv.space-111)](https://gsv.space)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/deathbyknowledge/gsv)

**🚀 Public beta is here! Issues and PRs very welcome.**

**GSV is an open-source, user-owned personal intelligence system.** It gives you one intelligence layer with durable memory, processes, permissions, and the ability to act across all your machines while remaining under your control.

Most personal AI agents run on one host you pick and keep alive — a laptop, VPS, or container. GSV instead deploys a lightweight, always-reachable control plane into your own Cloudflare account and turns your laptop, server, phone, and browser into one computer. Your GSV control plane and state remain in infrastructure you control; the model provider you configure necessarily receives the inference data routed to it. From about $5/month in infrastructure plus model usage.

## What you can do

- Run things across all your machines from one agent — kick off a job on your home server while your laptop's shut.
- Keep agents working while your devices sleep — they live on the edge, not on your hardware.
- Reach it from anywhere — web UI, CLI, or WhatsApp / Discord / Telegram.
- Spawn durable agents with their own memory and permissions, that can start sub-agents of their own.
- Host your own packages and share apps between GSV instances through a built-in git remote.
- Hand your agent the browser. The web extension lets it drive your real browser — your tabs and logged-in sessions — so it works the sites you already use, not just the public web.

Under the hood, GSV is a distributed operating environment: agents are durable processes with identities, history, permissions, and a capability-gated syscall surface. Named after the sentient ships from Iain M. Banks' Culture series, GSV (General Systems Vehicle) is a foundation for personal intelligence that lives across the edge and the machines you already own.

## Quick Start

**Prerequisites:** a [Cloudflare account](https://dash.cloudflare.com/sign-up) on the Workers Paid plan ($5/month), plus any credentials required by your chosen model provider. Model usage is billed separately by that provider.

### 1. Deploy

**From the web (easiest, no terminal).** Go to [deploy.gsv.space](https://deploy.gsv.space/), connect your Cloudflare account, and GSV deploys itself into it.

**Or from the terminal:**

```bash
# Install the CLI
curl -fsSL https://install.gsv.space | bash
# Deploy all components into your own Cloudflare account
gsv infra deploy --api-token <CLOUDFLARE-API-TOKEN>
```

Either way, open the URL it prints to finish onboarding in the web UI.

### 2. Start using it

Chat from the web UI right away, or from the CLI:

```bash
gsv chat "Hello, what can you help me with?"
```

To connect a messenger (Discord / Telegram / WhatsApp), add more devices, and see what to do next, follow the full guide at [docs.gsv.space/get-started](https://docs.gsv.space/get-started).

## Connect a Device

Connected devices are reachable by your agents from anywhere — outbound-only, so no open ports, no inbound connections, no VPN. Add one via **GSV > Devices** in the Web UI, or the CLI:

```bash
gsv auth token create --kind device --device macbook --label Macbook  # note the token
gsv config --local set device.token <token>
gsv device install --id macbook --workspace ~/  # background service
gsv device status
```

Now GSV can use the shell and read/write files on that machine. Set up adapters under **GSV > Integrations**.

## How GSV Works

GSV uses Linux as a design model (not POSIX, though). Familiar, composable primitives make the system understandable to both people and models.

- **Cloud computer** — a small, globally reachable hub running in your Cloudflare account. It coordinates identity, state, routing, packages, schedules, and agent loops rather than performing heavy local computation.
- **Kernel and syscalls** — humans, agents, apps, and the CLI use the same capability-gated primitives for processes, files, shells, networking, packages, and configuration. The public SDK exposes those contracts to apps and other clients.
- **Processes** — agents are durable processes with PIDs, histories, permissions, pending work, and subprocesses (`gsv proc list|spawn|send|kill`).
- **Targets** — the cloud runtime and connected devices implement the same targetable filesystem, shell, and network contracts. The browser extension exposes the browser through the same filesystem and shell shape. Changing the target changes where work runs, not what the syscall means.
- **Agent tools** — models see a deliberately small surface: Read, Write, Edit, Delete, Search, Shell, and CodeMode. Devices and integrations extend the system underneath those tools instead of making the tool list grow forever.
- **Messengers** — Discord, Telegram, and WhatsApp workers translate external chat platforms into stable GSV identities and process messages.

## Development

```bash
./scripts/setup-deps.sh        # install workspace and worker dependencies
npm run build --workspace web  # build assets served by the gateway
npm run dev                    # start the local multi-worker stack
```

Requires [Rust](https://rustup.rs) and [Node.js + npm](https://nodejs.org).

## 🤝 Get Involved

GSV is actively evolving, and we want you to be part of the network! We welcome contributions of all sizes.
Whether you want to submit a pull request, share a wild idea, or just say hi, please don't hesitate to reach out. :)

- **Join the Community:** Come hang out, talk shop, and share ideas on our [Discord Server](https://discord.gg/hy9ExJJFvn).
- **Found a bug or have a feature request?** [Open an issue](https://github.com/deathbyknowledge/gsv/issues).
- **Follow Updates:** Reach out directly on Twitter/X [@gsvspace](https://x.com/gsvspace)

## License

MIT
