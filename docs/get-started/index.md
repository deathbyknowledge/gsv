# Get Started with GSV

Use this guide when you want a working GSV deployment quickly.

By the end, you will have:

- a deployed GSV gateway on Cloudflare
- an admin user in the Desktop
- CLI access from your machine
- one connected device
- a clear next step for adapters, packages, or deeper architecture docs

## Before You Begin

You need:

- a Cloudflare account with Workers, Durable Objects, and R2 access
- an API token that can deploy Workers and manage R2 for the target account
- an AI provider API key
- the `gsv` CLI installed locally

If you want the account setup details first, read [Set Up Cloudflare](./cloudflare-setup.md).

Install the CLI:

```bash
curl -sSL https://install.gsv.space | bash
gsv version
```

Optionally save your Cloudflare credentials locally:

```bash
gsv config --local set cloudflare.api_token "$CF_API_TOKEN"
gsv config --local set cloudflare.account_id "$CF_ACCOUNT_ID"
```

## 1. Deploy GSV

Deploy the current Cloudflare components:

```bash
gsv infra deploy --all
```

This deploys the Gateway, supporting services, shared storage, and the built-in
adapter workers. The command prints a Gateway URL such as:

```text
https://gsv.<your-subdomain>.workers.dev
```

Open that URL in your browser.

If you want the operational version of this step, see [How to Deploy GSV](../how-to/deploy.md).

## 2. Complete Desktop Setup

The first browser visit opens setup mode. At minimum, expect to create the first
user and password. Depending on the setup path, you may also be asked for a
timezone, AI provider/model settings, and an initial device id.

When setup finishes, keep any generated CLI or device bootstrap commands. They
contain the exact Gateway URL, username, device id, and token for this
installation.

## 3. Use the Desktop

The Desktop is the main day-to-day interface. Start there before reaching for
CLI commands.

Key built-in surfaces include:

- **Chat** for talking to your init process
- **Files** for browsing the GSV filesystem
- **Shell** for commands in the cloud `gsv` target
- **Processes** for durable agent processes and history
- **Devices** for connected local machines
- **Packages** for installed apps and package management
- **Adapters** for WhatsApp and Discord
- **Control** for users, tokens, config, and identity links

A good first prompt is:

```text
What can you do in this GSV?
```

## 4. Configure Local CLI Access

If the Desktop did not already give you a ready-to-run CLI setup command,
configure it manually:

```bash
gsv config --local set gateway.url "wss://gsv.<your-subdomain>.workers.dev/ws"
gsv auth login --username admin
gsv chat "hello from the CLI"
```

Use the Desktop for normal interactive work. Use the CLI for automation,
debugging, and scripting.

## 5. Connect This Machine as a Device

Devices expose local filesystem and shell access through the same tool surface
agents already use.

Recommended path:

1. Open **Devices** in the Desktop.
2. Create or copy a token for a device id such as `macbook`.
3. Run the bootstrap command shown by the Desktop.

Manual equivalent:

```bash
gsv config --local set gateway.username "admin"
gsv config --local set node.id "macbook"
gsv config --local set node.token "<device-token>"
gsv device install --id macbook --workspace ~/projects
gsv device status
```

After the device connects, you can ask an agent to inspect files or run commands
on that machine by selecting its `target`.

## What to Read Next

- [Connect Adapters](./connect-adapters.md)
- [How to Run a Device](../how-to/run-a-device.md)
- [How to Manage Processes](../how-to/manage-processes.md)
- [Architecture Overview](../architecture/)

## See also

- [Set Up Cloudflare](./cloudflare-setup.md)
- [How to Deploy GSV](../how-to/deploy.md)
- [Why GSV?](../why/)
