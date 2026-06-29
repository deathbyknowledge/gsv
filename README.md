# GSV

![gsv](https://github.com/user-attachments/assets/e50a394b-e568-4306-bb48-e3b532c01eda)

> ***a mind for your machines***

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/deathbyknowledge/gsv)](https://github.com/deathbyknowledge/gsv/releases)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/hy9ExJJFvn)
[![X](https://img.shields.io/badge/X-@gsvspace-000?logo=x&logoColor=white)](https://x.com/gsvspace)
[![Docs](https://img.shields.io/badge/docs-gsv.space-111)](https://gsv.space)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/deathbyknowledge/gsv)

**🛸 Public beta — coming before July. Issues and PRs very welcome.**

Most personal AI agents run on one host you pick and keep alive — a laptop, a VPS, a container. GSV turns all your devices into a single computer. It spans your laptop, server, and phone at once, lets an agent act on whichever one fits, and runs on the edge in your own Cloudflare account; your keys, your data, no host to provision or babysit. From ~$5/mo infra plus your own model costs.


## What you can do

- Run things across all your machines from one agent — kick off a job on your home server while your laptop's shut.
- Keep agents working while your devices sleep — they live on the edge, not on your hardware.
- Reach it from anywhere — web UI, CLI, or WhatsApp / Discord / Telegram.
- Spawn durable agents with their own memory and permissions, that can start sub-agents of their own.
- Host your own packages and share apps between GSV instances through a built-in git remote.
- Hand your agent the browser. The web extension lets it drive your real browser — your tabs and logged-in sessions — so it works the sites you already use, not just the public web.

Under the hood it's a distributed OS: agents are durable processes with identities, history, permissions, and a syscall surface, plus an SDK for building apps. Named after the sentient ships from Iain M. Banks' Culture series, GSV (General Systems Vehicle) is a foundation for personal AI that lives across the edge.

## Quick Start

**Prerequisites:** a [Cloudflare account](https://dash.cloudflare.com/sign-up) on the Workers Paid plan ($5/mo), and an API key for whatever model provider you want to run. Your model usage is billed separately by that provider.

### 1. Deploy

**From the web (easiest, no terminal).** Go to [deploy.gsv.space](https://deploy.gsv.space/), connect your Cloudflare account, and GSV deploys itself into it.

**Or from the terminal:**

```bash
# Install the CLI
curl -sSL https://install.gsv.space | bash
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
gsv auth token create --device macbook --label Macbook   # note the token
gsv config --local set node.token <token>
gsv device install --id macbook --workspace ~/           # background service
gsv device status
```

Now GSV can use the shell and read/write files on that machine. Set up adapters under **GSV > Integrations**.

## OS Model

Linux-like by design, so agents can reason with familiar patterns (mental model, not POSIX).

- **Kernel** — the Gateway runs on Cloudflare, exposing authenticated syscalls (`proc.*`, `pkg.*`, `sys.*`).
- **Processes** — agents are durable processes with PIDs (`gsv proc list|spawn|send|kill`).
- **Devices** — connected machines act as execution nodes, scoped to a workspace.
- **Messengers** — Discord/Telegram/Whatsapp workers act like device drivers for external chat.

## Development

```bash
./scripts/setup-deps.sh       # install JS deps across workspace, adapters, ripgit
cd web && npm run build    # build web app
cd .. && npm run dev           # local multi-worker dev stack
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
