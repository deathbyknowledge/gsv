# Getting Started with GSV

This tutorial deploys GSV, completes first-run setup in the Web UI, opens the
Desktop, and connects your machine as a device. After this, agents can chat,
read files, run shell commands, and target devices through the same Linux-like
syscall surface they use in production.

## Prerequisites

- A Cloudflare account with Workers, Durable Objects, and R2 access.
- A Cloudflare API token that can edit Workers and R2 resources.
- An AI provider API key.
- The `gsv` CLI installed:

```bash
curl -sSL https://install.gsv.space | bash
gsv version
```

Save Cloudflare credentials locally if you do not want to pass flags each time:

```bash
gsv config --local set cloudflare.api_token "$CF_API_TOKEN"
gsv config --local set cloudflare.account_id "$CF_ACCOUNT_ID"
```

## 1. Deploy GSV

Deploy the current Cloudflare components:

```bash
gsv infra deploy --all
```

This deploys the Gateway, Kernel-facing services, shared storage, and adapter
Workers for WhatsApp and Discord. The command prints a Gateway URL such as:

```text
https://gsv.<your-subdomain>.workers.dev
```

Open that URL in your browser.

## 2. Complete Web Setup

The first browser visit opens setup mode. Choose the setup path that matches
what you need:

- **Quick start** creates the first Desktop user with sensible defaults.
- **Customize** lets you set the AI provider, model, API key, and initial device.
- **Advanced** exposes the same controls plus lower-level system source options.

When setup finishes, enter the Desktop. If setup produced CLI or device
bootstrap commands, keep them available; they contain the exact Gateway URL,
username, device id, and token for this deployment.

## 3. Use the Desktop

The Desktop is the primary interface for day-to-day work. Start here before
reaching for CLI commands:

- **Chat** sends messages to your init process.
- **Files** browses the GSV filesystem.
- **Shell** runs commands in the gateway OS context.
- **Processes** shows running agent processes and history.
- **Devices** lists connected local drivers and can issue device tokens.
- **Packages** reviews and manages installed package apps.
- **Adapters** connects WhatsApp and Discord accounts.
- **Control** manages users, tokens, configuration, and identity links.

Open **Chat** and ask:

```text
What can you do in this GSV?
```

## 4. Configure Local CLI Access

The Web UI may already give you a ready-to-run CLI setup command. If you need to
configure it manually, set the WebSocket URL and log in:

```bash
gsv config --local set gateway.url "wss://gsv.<your-subdomain>.workers.dev/ws"
gsv auth login --username admin
gsv chat "hello from the CLI"
```

Use the CLI for automation and debugging. Use the Desktop for normal interactive
setup, especially package apps and adapters.

## 5. Connect This Machine as a Device

Devices expose local hardware-style capabilities such as filesystem and shell
access. Agents always see the same tool/syscall interface; the selected device
decides where the work runs.

Recommended path:

1. Open **Devices** in the Desktop.
2. Issue a token for a device id such as `macbook` or use the token created
   during setup.
3. Run the bootstrap command shown by the Web UI.

Manual equivalent:

```bash
gsv config --local set gateway.username "admin"
gsv config --local set node.id "macbook"
gsv config --local set node.token "<device-token>"
gsv device install --id macbook --workspace ~/projects
gsv device status
```

After the device connects, ask Chat to inspect a project or run a shell command
on that device. GSV routes the request to the selected device without exposing a
different tool set for each machine.

## Next Steps

- [Connect WhatsApp or Discord adapters](setting-up-a-channel.md).
- [Write a package app](../how-to/write-a-package-app.md).
- [Review the architecture](../explanation/architecture.md).
