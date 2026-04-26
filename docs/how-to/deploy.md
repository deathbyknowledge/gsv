# How to Deploy GSV

This guide deploys GSV infrastructure to Cloudflare, initializes the first user,
and shows the safe update and teardown paths.

## Prerequisites

- A Cloudflare account with Workers, Durable Objects, and R2 access.
- A Cloudflare API token with permission to edit Workers and R2 resources.
- The `gsv` CLI installed.

```bash
curl -sSL https://install.gsv.space | bash
```

Save Cloudflare credentials locally if you do not want to pass them each time:

```bash
gsv config --local set cloudflare.api_token "$CF_API_TOKEN"
gsv config --local set cloudflare.account_id "$CF_ACCOUNT_ID"
```

## Deploy Infrastructure

Deploy all current components:

```bash
gsv infra deploy --all
```

The components are `ripgit`, `assembler`, `gateway`, `channel-whatsapp`, and
`channel-discord`. To deploy only a subset:

```bash
gsv infra deploy -c ripgit -c assembler -c gateway
gsv infra deploy -c channel-whatsapp
```

Deploying `gateway` expects `ripgit` and `assembler` to be deployed already or
selected in the same command. If you deploy Discord, provide the bot token during
deploy or later through the adapter UI/config:

```bash
gsv infra deploy -c channel-discord --discord-bot-token "$DISCORD_BOT_TOKEN"
```

## Configure the CLI and First User

After deployment, the CLI prints the Gateway Worker URL. Store the WebSocket URL
locally:

```bash
gsv config --local set gateway.url wss://gsv.<your-subdomain>.workers.dev/ws
```

Initialize the Kernel while it is in setup mode:

```bash
gsv auth setup \
  --username admin \
  --new-password "$GSV_PASSWORD" \
  --ai-provider openrouter \
  --ai-model openai/gpt-4.1 \
  --ai-api-key "$OPENROUTER_API_KEY" \
  --node-id macbook
```

`auth setup` creates the first non-root user, writes AI config, and can issue a
device token bound to `--node-id`. It saves `gateway.username`, `node.id`, and
`node.token` locally when those values are returned.

Log in and test chat:

```bash
gsv auth login --username admin
gsv chat "hello"
```

## Upgrade

Upgrade deployed components from the selected release channel:

```bash
gsv infra upgrade --all
```

Use `--version dev`, `--version stable`, or a release tag to control the bundle
source. Mutable refs such as `dev`, `stable`, and `latest` refresh bundles
automatically; use `--force-fetch` when you need to refresh manually.

For local bundle testing:

```bash
./scripts/build-cloudflare-bundles.sh
gsv infra deploy --bundle-dir ./release/local --version local-dev --all --force-fetch
```

## Destroy

Remove deployed workers:

```bash
gsv infra destroy --all
```

Remove only selected components:

```bash
gsv infra destroy -c channel-whatsapp
```

Delete the shared R2 bucket only when you intend to destroy stored files,
artifacts, media, and archives:

```bash
gsv infra destroy --all --delete-bucket --purge-bucket
```

By default, destroy also tries to uninstall the local device daemon. Use
`--keep-node` to leave it installed.
