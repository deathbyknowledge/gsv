# Ship

<img src="web/public/brand/gsv-ship.png" alt="Ship's ASCII ship" width="240" height="240" />

> ***a mind for your machines***

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/deathbyknowledge/gsv)](https://github.com/deathbyknowledge/gsv/releases)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/hy9ExJJFvn)
[![X](https://img.shields.io/badge/X-@shipdotspace-000?logo=x&logoColor=white)](https://x.com/gsvspace)
[![Docs](https://img.shields.io/badge/docs-ship.space-111)](https://ship.space)

**🚀 Public beta is here! Issues and PRs very welcome.**

**Ship is your personal spaceship.** It stays in orbit while you live your life down here on Earth. Talk to your Ship, give it work, and keep your files and projects aboard. It uses the technology you connect to it and keeps work running while you are away.

Ship is open source and user owned, with durable memory, processes, permissions, and the ability to act across your machines under your control.

Most personal AI agents run on one host you pick and keep alive — a laptop, VPS, or container. Ship instead deploys a lightweight, always-reachable control plane into your own Cloudflare account and turns your laptop, server, phone, and browser into one computer. Your Ship control plane and state remain in infrastructure you control; the model provider you configure necessarily receives the inference data routed to it. The public composition includes CodeMode and requires [Workers Paid](https://developers.cloudflare.com/dynamic-workers/pricing/), plus model usage.

## What you can do

- Run things across all your machines from one agent — kick off a job on your home server while your laptop's shut.
- Keep agents working while your devices sleep — they live on the edge, not on your hardware.
- Reach it from anywhere — web UI, CLI, or an extensible adapter system with
  Discord, Telegram, and Slack implementations bundled today.
- Spawn durable agents with their own memory and permissions, that can start sub-agents of their own.
- Keep your repositories and knowledge source-inspectable through a built-in git remote.
- Hand your agent the browser. The web extension lets it drive your real browser — your tabs and logged-in sessions — so it works the sites you already use, not just the public web.

Under the hood, GSV is the distributed operating environment: agents are durable processes with identities, history, permissions, and a capability-gated syscall surface. Named after the sentient ships from Iain M. Banks' Culture series, GSV (General Systems Vehicle) is a foundation for personal intelligence that lives across the edge and the machines you already own.

## Quick Start

**Prerequisites:** a [Cloudflare account](https://dash.cloudflare.com/sign-up), plus any credentials required by your chosen model provider. The public composition includes CodeMode and requires [Workers Paid](https://developers.cloudflare.com/dynamic-workers/pricing/). Model usage is billed separately by its provider.

### 1. Deploy

**Deploy the open-source operator stack from the terminal.** You need a
domain in a Cloudflare DNS zone, Node.js and Rust for the source build:

```bash
git clone https://github.com/deathbyknowledge/gsv.git
cd gsv
npm ci
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export GSV_DOMAIN="example.com"
export GSV_ZONE_ID="your-zone-id"
npx alchemy login
npx alchemy cloudflare bootstrap
npm run deployment:plan
npm run deployment:deploy
```

The terminal flow deploys the `operator` stage with public Accounts and inference,
and no messenger adapters enabled by default. Follow the
[Alchemy guide](docs/how-to/deploy-with-alchemy.md#create-the-first-space) to issue
the one-time bootstrap link and create your first space. Subsequent spaces use
operator administration. Existing standalone deployments must stay on the
[preserved release or source](docs/how-to/standalone-retirement.md) until an
explicit migration is prepared; these commands do not adopt their state.

Install the CLI, machine daemon, and Desktop separately where supported:

```bash
curl -fsSL https://install.ship.space | bash
```

The verified host installer ships matching versions of `gsv` and `gsvd` on
Linux x64/ARM64, macOS Intel/Apple Silicon, and Windows x64, into a per-user
directory (`~/.gsv/bin`) that the daemon keeps current on its own. Linux and macOS
also receive the native Desktop plus its isolated local transcription
helper; launch it with `gsv desktop`. See the
[host application install and upgrade guide](docs/how-to/install-host-apps.md)
for platform details and service rollback behavior.

### 2. Start using it

Chat from the web UI right away, or from the CLI:

```bash
gsv chat "Hello, what can you help me with?"
```

To connect a messenger (Discord / Telegram / Slack), add more devices, and see what to do next, follow the full guide at [docs.gsv.space/get-started](https://docs.gsv.space/get-started).

## Connect a Device

Connected devices are reachable by your agents from anywhere — outbound-only, so no open ports, no inbound connections, no VPN. Add one via **Ship > Devices** in the Web UI, or the CLI:

```bash
gsv auth token create --kind machine --peer macbook --label Macbook  # note the token
gsv config --local set device.token <token>
gsv daemon install --id macbook --workspace ~/  # background service
gsv daemon status
```

Now Ship can use the shell and read/write files on that machine. Set up adapters under **Ship > Integrations**.

## How Ship Works

Ship uses Linux as a design model (not POSIX, though). Familiar, composable primitives make the system understandable to both people and models.

- **Cloud computer** — a small, globally reachable hub running in your Cloudflare account. It coordinates identity, state, routing, schedules, and agent loops rather than performing heavy local computation.
- **Kernel and syscalls** — humans, agents, and the CLI use the same capability-gated primitives for processes, files, shells, networking, repositories, and configuration. The public client exposes those contracts to other clients.
- **Processes** — agents are durable processes with PIDs, histories, permissions, pending work, and subprocesses (`gsv proc list|spawn|send|kill`).
- **Targets** — the cloud runtime and connected devices implement the same targetable filesystem, shell, and network contracts. The browser extension exposes the browser through the same filesystem and shell shape. Changing the target changes where work runs, not what the syscall means.
- **Agent tools** — models see a deliberately small surface: Read, Write, Edit, Delete, Search, Shell, CodeMode, and Send. Devices and integrations extend the system underneath those tools instead of making the tool list grow forever.
- **Adapters** — independently deployed Workers translate external services into stable Ship actors, surfaces, and messages. The repository bundles several implementations, while the `AdapterService` contract remains open to new providers.

## Development

```bash
./scripts/setup-deps.sh        # install workspace and worker dependencies
npm run build --workspace web  # build assets served by the gateway
npm run dev                    # start the local multi-worker stack
GSV_MANAGED_SERVICES_ROOT=/path/to/services npm run dev:managed
```

`npm run dev` starts public Accounts, inference, Gateway and ripgit on
`http://localhost:8976`; open `/admin` to create a local space. No private
repository is required. The optional `dev:managed` command uses an operator's
compatible `accounts/` and `inference/` packages, including its funding policy.
See [service contracts](docs/architecture/services.md) for the boundaries.

Requires [Rust](https://rustup.rs) and Node.js 22 or newer with
[npm](https://nodejs.org).

## 🤝 Get Involved

Ship is actively evolving, and we want you to be part of the network! We welcome contributions of all sizes.
Whether you want to submit a pull request, share a wild idea, or just say hi, please don't hesitate to reach out. :)

- **Join the Community:** Come hang out, talk shop, and share ideas on our [Discord Server](https://discord.gg/hy9ExJJFvn).
- **Found a bug or have a feature request?** [Open an issue](https://github.com/deathbyknowledge/gsv/issues).
- **Follow Updates:** Reach out directly on Twitter/X [@gsvspace](https://x.com/gsvspace)

## License

MIT
