# Ship

<a href="https://ship.space/#demo">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/readme-refund-dark.png">
    <img src=".github/assets/readme-refund-light.png" width="460" alt="A conversation with Ship. Ship: Hey, still no refund confirmation for those shoes you returned. Want me to follow up? You: yes please. Ship: Cool, email sent. I'll keep an eye on the reply. Ship: Your refund has been processed! They just confirmed it by email. Ship: By the way, your streaming trial ends tomorrow. Want me to cancel it before you're charged?">
  </picture>
</a>

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/deathbyknowledge/gsv)](https://github.com/deathbyknowledge/gsv/releases)
[![Docs](https://img.shields.io/badge/docs-docs.gsv.space-111)](https://docs.gsv.space)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/hy9ExJJFvn)
[![X](https://img.shields.io/badge/X-@shipdotspace-000?logo=x&logoColor=white)](https://x.com/shipdotspace)

Ship is an open-source personal AI agent. You give it things to do from the web
app, the Desktop app, the `gsv` CLI or a messenger. It works on them with the
computers, browsers and accounts you connect, keeps going between
conversations, and tells you when something changes.

This repository is **GSV**, the runtime Ship is built on: the control plane,
agent processes, protocol, clients and deployment. Use the hosted Ship at
[ship.space](https://signup.ship.space), or deploy GSV to your own Cloudflare
account and run your own.

## What's in this repository

| Path | What it is |
| --- | --- |
| [`workers/gateway/`](workers/gateway/) | The Gateway: the Kernel (identity, capabilities, syscalls, routing, schedules), agent processes, conversations and the cloud target |
| [`workers/installations/`](workers/installations/) | Accounts: the directory of Ships, sign-in, onboarding and operator administration |
| [`workers/inference/`](workers/inference/), [`packages/inference/`](packages/inference/) | Model requests and provider integration |
| [`workers/adapters/`](workers/adapters/) | Messengers: WhatsApp, Telegram, Slack, Discord and email |
| [`workers/instances/`](workers/instances/) | Optional cloud browsers and cloud computers |
| [`workers/pds/`](workers/pds/) | Optional AT Protocol host for each Ship's public profile |
| [`workers/ripgit/`](workers/ripgit/) | Git-backed repositories and file storage |
| [`web/`](web/) | The web app, also used by Desktop |
| [`host/`](host/) | Rust host apps: the `gsv` CLI, the `gsvd` machine daemon and Desktop |
| [`extension/`](extension/) | The browser extension, which lets Ship work in your browser |
| [`packages/gsv/`](packages/gsv/) | The public TypeScript client and protocol |
| [`lexicons/`](lexicons/) | The `space.ship.*` record types |
| [`deployment/`](deployment/) | The Cloudflare deployment |
| [`docs/`](docs/) | The documentation at [docs.gsv.space](https://docs.gsv.space) |

## Self-host

You need a Cloudflare account on
[Workers Paid](https://developers.cloudflare.com/dynamic-workers/pricing/), a
domain in one of its DNS zones, Node.js 22 or newer, npm and Rust.

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

Administration lives at `https://accounts.example.com` and each Ship at
`<handle>.example.com`. Models run on your account's Workers AI by default, and
each person can add their own provider keys. Messengers are off until you
enable them. Next, [create the first Ship](docs/how-to/deploy-with-alchemy.md#create-the-first-space)
with the one-time link the deployment issues.

Install the CLI, the machine daemon and Desktop:

```bash
curl -fsSL https://install.ship.space | bash        # Linux and macOS
irm https://install.ship.space/install.ps1 | iex    # Windows PowerShell
```

Then sign in and talk to your Ship:

```bash
gsv login you.example.com
gsv ship "Hello, what can you help me with?"
```

To connect a computer, open **Work**, click **connect** beside Connections and
run the `gsv pair` command it gives you on that computer. Connections are
outbound only, so there are no ports to open. See
[Connect devices](docs/how-to/connect-devices.md),
[Messengers](docs/how-to/messengers.md) and the full
[deployment guide](docs/how-to/deploy-with-alchemy.md).

## Develop

```bash
./scripts/setup-deps.sh        # install workspace and worker dependencies
npm run build --workspace web  # build the web app the Gateway serves
npm run dev                    # start the local stack
```

`npm run dev` runs Accounts, inference, the Gateway and ripgit at
`http://localhost:8976`; open `/admin` to create a local Ship. Read
[AGENTS.md](AGENTS.md) before changing code: it is the engineering contract and
lists the checks for each part of the repository.

## How it works

GSV borrows Linux's ideas, not its compatibility: familiar, composable
primitives that people and models both understand.

- **Gateway**: a small control plane on Cloudflare's edge. It owns identity,
  permissions, routing, schedules and agent loops; heavy work runs on the
  device or service it belongs to.
- **Syscalls**: people, agents and the CLI use the same capability-checked
  calls for processes, files, shells, networking, repositories and settings.
- **Processes**: agents are durable processes with their own identity, history,
  permissions and queue. Ship hands work to helper processes and records what
  it has promised in a durable ledger, so nothing is forgotten between runs.
- **Targets**: Ship's cloud home, your computers, your browser and cloud
  instances offer the same file, shell and network calls. Choosing a target
  changes where work runs, not what a command means.
- **Agent tools**: the model sees eight tools: Read, Write, Edit, Delete,
  Search, Shell, CodeMode and Send. Integrations add capabilities beneath them
  instead of new tools.
- **Adapters**: each messenger is a separate Worker that turns its messages
  into the same people, places and messages for the Kernel.
- **Open network**: every Ship publishes a public profile on the
  [AT Protocol](https://atproto.com) network, and its owner decides what it
  shows.

GSV is named after the General Systems Vehicles, the ship Minds of Iain M.
Banks' Culture novels. Read more in the [architecture docs](docs/architecture/index.md),
the [syscall reference](docs/reference/syscalls.md) and the
[security model](docs/architecture/security-model.md).

## Contributing

Bug reports, ideas and pull requests are welcome. Open an
[issue](https://github.com/deathbyknowledge/gsv/issues) or talk to us on
[Discord](https://discord.gg/hy9ExJJFvn).

## License

[MIT](LICENSE)
