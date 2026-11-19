# Ship: your personal AI assistant

<img src="web/public/brand/gsv-ship.png" alt="Ship's ASCII ship" width="240" height="240" />

> ***Less on your mind.***

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/deathbyknowledge/gsv)](https://github.com/deathbyknowledge/gsv/releases)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/hy9ExJJFvn)
[![X](https://img.shields.io/badge/X-@gsvspace-000?logo=x&logoColor=white)](https://x.com/gsvspace)
[![Docs](https://img.shields.io/badge/docs-read-111)](docs/index.md)

## What is Ship?

**Ship is your personal AI assistant for the things you keep meaning to do.** Find an appointment, chase a refund, plan a trip, or keep an eye on tickets. Give it something to do, or something to keep an eye on, and Ship can work through the steps and keep you posted.

Ship remembers useful things across conversations, so you can pick up where you left off. You choose which accounts and devices to connect, can see what it does, and decide which actions need your approval.

[Try Ship](https://signup.ship.space) · [Website](https://ship.space) · [FAQ](#frequently-asked-questions) · [Self-hosting](#self-hosting) · [Documentation](docs/index.md)

## What can Ship do?

Here are some things you can ask Ship to help with:

- **Find an appointment.** “Find a dentist near my office with appointments after work.”
- **Chase a refund.** “I returned those shoes two weeks ago. Find the return details and draft a follow-up.”
- **Watch for tickets.** “Keep checking for two tickets under my budget and let me know when you find a match.”
- **Plan a day out.** “Turn the places I've saved into a Saturday plan, with opening times and a route.”
- **Compare a bill.** “Here's my internet bill. Is there a better deal, and what's the catch?”
- **Track a delivery.** “Keep an eye on my parcel and tell me if the delivery date changes.”

Ship can look things up, work in the browser and accounts you connect, and come back to a task later. You can review its activity, manage approvals, and stop ongoing work. See [more examples](https://ship.space) or the [device and browser connection guide](docs/how-to/connect-devices.md).

## Quick Start

1. [Create your Ship](https://signup.ship.space) and start talking in your browser.
2. Give it one thing you've been putting off, or something you'd like it to check regularly.
3. Connect your browser, computer, or other accounts when a task needs them.

You can also message Ship on WhatsApp or Telegram when available, or use the Desktop app. It is the same assistant, so you can hand over a task and hear back while you're out. See the [getting started guide](docs/get-started/index.md).

Ship is in public beta and [open source](LICENSE). You can inspect the code, contribute, or run your own Ship.

## Frequently asked questions

### Do I need to set anything up to try Ship?

Create an account at [ship.space](https://ship.space) and start talking. You do not need to deploy anything or bring an API key to try hosted Ship. Connect your browser, computer, or other accounts when you want Ship to work with them.

### Is Ship free to use?

Hosted Ship at [ship.space](https://ship.space) is currently free. Ship's source code is also free to use, modify, and distribute under the [MIT License](LICENSE). If you choose to self-host, you pay for your own Cloudflare infrastructure and model usage; see [self-hosting](#self-hosting) for requirements.

### How much control do I have over what Ship does?

You choose which accounts and devices to connect and which actions need your approval. You can review activity, stop ongoing work, and pause or disconnect your browser. Depending on your settings, some actions can happen automatically. See the [permissions and security model](docs/architecture/security-model.md).

### Does Ship keep working when my laptop is off?

Yes. Ship can run scheduled tasks and keep working with its cloud tools while you're away. Work that needs your own computer or browser waits until that device is available. See the [runtime FAQ](docs/get-started/faq.md#does-it-keep-running-when-my-devices-are-off).

### Can Ship use my existing browser sessions?

Yes. The **Your Ship** browser extension lets Ship work in your connected browser, including websites where you are already signed in. You can pause access from the extension panel. The browser must remain online; operators may also offer cloud browsers for work independent of your devices. See [Connect a browser](docs/how-to/connect-devices.md#connect-a-browser).

### Where is my data stored?

Ship's cloud state lives in its operator's Cloudflare account; self-hosting puts that state in your own account. Model providers and connected services receive the data routed to them for inference or actions. Connected computers use outbound connections to the gateway, so pairing does not require opening inbound ports. See the [security model](docs/architecture/security-model.md).

### Which AI models can Ship use?

The public inference service uses the operator's Cloudflare Workers AI account by default. You can add your own model-provider credentials and choose the order in which models are tried under **Settings → Preferences → Model order**. See [Bring your own model](docs/how-to/bring-your-own-model.md) for configuration.

### Can I self-host Ship?

Yes. Ship's public runtime, Accounts, inference, and deployment components can run in your own Cloudflare account without private Humans & Machines services. The supported deployment uses Cloudflare Workers, Durable Objects, and storage services; running the full stack entirely on your own hardware is not currently supported. Follow the [Alchemy deployment guide](docs/how-to/deploy-with-alchemy.md).

## Self-hosting

To run your own Ship, deploy the open-source stack into your [Cloudflare account](https://dash.cloudflare.com/sign-up). You need a domain in a Cloudflare DNS zone, Node.js 22 or newer, npm, and Rust. The public composition includes CodeMode and requires [Workers Paid](https://developers.cloudflare.com/dynamic-workers/pricing/). Infrastructure and model usage incur charges; the source code is [MIT-licensed](LICENSE).

### 1. Deploy

Deploy the open-source operator stack from the terminal:

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
[Alchemy guide](docs/how-to/deploy-with-alchemy.md) to issue
the one-time bootstrap link and create your first space. Subsequent spaces use
operator administration. Existing standalone deployments must stay on the
[preserved release or source](docs/how-to/standalone-retirement.md) until an
explicit migration is prepared; these commands do not adopt their state.

The default inference service uses your operator account's Cloudflare Workers AI.
You can also [add your own model provider](docs/how-to/bring-your-own-model.md).

### 2. Install the host applications

Install the CLI (`gsv`), machine daemon (`gsvd`), and Desktop on Linux or macOS:

```bash
curl -fsSL https://install.ship.space | bash
```

On Windows, use PowerShell:

```powershell
irm https://install.ship.space/install.ps1 | iex
```

Releases support Linux x64/ARM64, macOS Intel/Apple Silicon, and Windows 10+ x64.
Launch Desktop with `gsv desktop`. See the
[host application install and upgrade guide](docs/how-to/install-host-apps.md)
for platform requirements, updates, and service rollback behavior.

### 3. Start using it

Chat from the web UI right away, or from the CLI:

```bash
gsv login your-space.example
gsv ship "Hello, what can you help me with?"
```

To connect a messenger, add more devices, and see what to do next, follow the [getting started guide](docs/get-started/index.md).

## Connect a Device

Connected devices are reachable by your agents from anywhere — outbound-only, so no open ports, no inbound connections, no VPN. Open **Work** in the web UI, click **connect** beside Connections and create an invitation, then run the command it gives you on that computer:

```bash
gsv pair CODE   # saves the connection and starts the background service
gsv status
```

While that computer is online, Ship can use its shell and read/write files within
the granted permissions. Link enabled messaging adapters under **Settings → Messengers**.

## How Ship Works

**Ship is the product; GSV is its underlying runtime and protocol.** GSV stands for General Systems Vehicle, named after the sentient ships in Iain M. Banks' Culture novels. The repository is `deathbyknowledge/gsv`, the CLI command is `gsv`, and existing `.gsv` paths retain that name.

Ship uses Linux as a design model (not POSIX, though). Familiar, composable primitives make the system understandable to both people and models.

- **Cloud control plane** — a small, globally reachable hub running on Cloudflare Workers and Durable Objects in the operator's account, or your own account when self-hosted. It coordinates identity, state, routing, schedules, and agent loops. Connected devices and services execute work that needs their hardware or access.
- **Kernel and syscalls** — humans, agents, and the CLI use the same capability-gated primitives for processes, files, shells, networking, repositories, and configuration. The public client exposes those contracts to other clients.
- **Processes** — agents are durable processes with PIDs, histories, permissions, pending work, and subprocesses (`gsv work` lists them).
- **Targets** — the cloud runtime and connected devices implement the same targetable filesystem, shell, and network contracts. The browser extension exposes the browser through the same filesystem and shell shape. Changing the target changes where work runs, not what the syscall means.
- **Agent tools** — models see a deliberately small surface: Read, Write, Edit, Delete, Search, Shell, CodeMode, and Send. Devices and integrations extend the system underneath those tools instead of making the tool list grow forever.
- **Adapters** — independently deployed Workers translate external services into stable Ship actors, surfaces, and messages. The repository bundles several implementations, while the `AdapterService` contract remains open to new providers.

Read the [architecture overview](docs/architecture/index.md) and [security model](docs/architecture/security-model.md) for the runtime and permission boundaries.

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

**🚀 Public beta is here! Issues and PRs very welcome.**

Ship is actively evolving, and we want you to be part of the network! We welcome contributions of all sizes.
Whether you want to submit a pull request, share a wild idea, or just say hi, please don't hesitate to reach out. :)

- **Join the Community:** Come hang out, talk shop, and share ideas on our [Discord Server](https://discord.gg/hy9ExJJFvn).
- **Found a bug or have a feature request?** [Open an issue](https://github.com/deathbyknowledge/gsv/issues).
- **Follow Updates:** Reach out directly on Twitter/X [@gsvspace](https://x.com/gsvspace)

## License

Ship's open-source code is available under the [MIT License](LICENSE).
