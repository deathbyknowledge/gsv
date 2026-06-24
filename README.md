# GSV
![gsv](https://github.com/user-attachments/assets/fd40032c-d551-44e4-ba77-7808d29cc0a1)
> ***A mind for your machines, by [Humans & Machines, Inc.](https://humanandmachin.es)***

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/deathbyknowledge/gsv)](https://github.com/deathbyknowledge/gsv/releases)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/hy9ExJJFvn)
[![X](https://img.shields.io/badge/X-@humachinesinc-000?logo=x&logoColor=white)](https://x.com/humachinesinc)
[![Website](https://img.shields.io/badge/site-gsv.space-111)](https://gsv.space)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/deathbyknowledge/gsv)

> **GSV is actively baking! 🏗️**
> 🛸 Public beta — coming before July. Issues and PRs very welcome.

Most personal AI agents run on one host you pick and keep alive — a laptop, a VPS, a container. GSV turns all your devices into a single computer. It spans your laptop, server, and phone at once, lets an agent act on whichever one fits, and runs on the edge in your own Cloudflare account; your keys, your data, no host to provision or babysit. From ~$5/mo infra plus your own model costs.

## What you can do

- Run things across all your machines from one agent — kick off a job on your home server while your laptop's shut.
- Keep agents working while your devices sleep — they live on the edge, not your hardware.
- Reach it from anywhere — web UI, CLI, or Discord / Telegram.
- Spawn durable agents with their own memory, permissions, and the ability to start sub-agents.
- Host your own packages and share apps between GSV instances through a built-in git remote.

Under the hood it's a distributed OS: agents are durable processes with identities, history, permissions, and a syscall surface, plus an SDK for building apps. Named after the sentient ships from Iain M. Banks' Culture series, GSV (General Systems Vehicle) is a foundation for personal AI that lives across the edge.

## Quick Start

Prerequisite: a [Cloudflare account](https://dash.cloudflare.com/sign-up) on the Workers Paid plan ($5/month).

<!-- DROP-IN once the web deploy is verified & working end-to-end. Make this the
     recommended path and move the CLI block below it under "Or, from the terminal".

**Easiest — deploy from the web.** Head to [gsv.space/deploy](https://gsv.space/deploy),
connect your Cloudflare account, and GSV sets everything up for you. No terminal needed.

### Or, from the terminal
-->

```bash
# Install CLI
curl -sSL https://install.gsv.space | bash
# Deploy all components to your Cloudflare account
gsv infra deploy --api-token <CLOUDFLARE-API-TOKEN>
```

Open the URL it prints to finish onboarding in the Web UI. Then chat from the UI, a connected adapter (WhatsApp/Discord/Telegram), or the CLI:

```bash
gsv chat "Hello, what can you help me with?"
```

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
- **Adapters** — WhatsApp/Discord/Telegram workers act like device drivers for external chat.

## Development

```bash
./scripts/setup-deps.sh        # install JS deps across workspace, adapters, ripgit
npm run dev                    # local multi-worker dev stack
cd cli && cargo build --release
./scripts/deploy-local.sh      # build + deploy local bundles (defaults to -c gateway)
```

Requires [Rust](https://rustup.rs) and [Node.js + npm](https://nodejs.org).


## 🤝 Get Involved

GSV is actively evolving, and we want you to be part of the network! We welcome contributions of all sizes.
Whether you want to submit a pull request, share a wild idea, or just say hi, please don't hesitate to reach out. :)

- **Join the Community:** Come hang out, talk shop, and share ideas on our [Discord Server](https://discord.gg/hy9ExJJFvn).
- **Found a bug or have a feature request?** [Open an issue](https://github.com/deathbyknowledge/gsv/issues).
- **Follow Updates:** Reach out directly on Twitter/X [@humachinesinc](https://x.com/humachinesinc)



## License

MIT
