# How to Deploy GSV

This guide walks you through deploying GSV to Cloudflare, updating an existing deployment, and tearing it down.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- A [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) with the "Edit Cloudflare Workers" template
- An API key for your LLM provider (Anthropic, OpenAI, Google, or OpenRouter)
- The `gsv` CLI installed:

```bash
curl -sSL https://install.gsv.space | bash
```

## First-time deploy with the wizard

The wizard walks you through account selection, component selection, LLM provider setup, and optional channel configuration:

```bash
gsv deploy up --wizard
```

The wizard prompts for:

1. **Cloudflare API token** (if not already configured)
2. **Cloudflare account** (auto-selected if you only have one)
3. **Components** to deploy (gateway, channel-whatsapp, channel-discord)
4. **LLM provider and model** (defaults to Anthropic / Claude Sonnet)
5. **LLM API key**
6. **Discord bot token** (if deploying the Discord channel)

On completion, the wizard saves the gateway URL and auth token to your local config so `gsv client` and `gsv node` work immediately.

## Deploy all components non-interactively

If you already have credentials configured, skip the wizard:

```bash
gsv deploy up --all \
  --api-token "$CF_API_TOKEN" \
  --account-id "$CF_ACCOUNT_ID" \
  --llm-provider anthropic \
  --llm-model claude-sonnet-4-20250514 \
  --llm-api-key "$ANTHROPIC_API_KEY"
```

## Deploy specific components

Deploy only the gateway:

```bash
gsv deploy up -c gateway
```

Deploy the gateway and WhatsApp channel:

```bash
gsv deploy up -c gateway -c channel-whatsapp
```

Available components: `gateway`, `channel-whatsapp`, `channel-discord`.

## Deploy from local bundles

If you're building from source or testing local changes:

```bash
./scripts/build-cloudflare-bundles.sh
gsv deploy up --bundle-dir ./release/local --version local-dev --all --force-fetch
```

## Set secrets and API keys after deploy

Use `gsv config set` to update gateway configuration remotely:

```bash
# Change the LLM provider and model
gsv config set model.provider anthropic
gsv config set model.id claude-sonnet-4-20250514

# Set or rotate an API key
gsv config set apiKeys.anthropic sk-ant-...

# Set the auth token
gsv config set auth.token your-secret-token
```

For channel worker secrets (like Discord bot tokens), pass them during deploy:

```bash
gsv deploy up -c channel-discord --discord-bot-token "$DISCORD_BOT_TOKEN"
```

## Check deployment status

```bash
gsv deploy status --all
```

Or for a specific component:

```bash
gsv deploy status -c gateway
```

## Update an existing deployment

Re-run `gsv deploy up` with the same components. It fetches the latest release bundles and applies them:

```bash
gsv deploy up --all
```

To force re-download of bundles (e.g., if a release was re-published):

```bash
gsv deploy up --all --force-fetch
```

To deploy a specific version:

```bash
gsv deploy up --all --version v0.3.0
```

## Tear down

Remove all deployed workers:

```bash
gsv deploy down --all
```

Remove specific components:

```bash
gsv deploy down -c channel-whatsapp
```

To also delete the R2 storage bucket (this destroys all agent data, workspace files, and session archives):

```bash
gsv deploy down --all --delete-bucket --purge-bucket
```

Use `--wizard` for an interactive teardown flow:

```bash
gsv deploy down --wizard
```

## Save Cloudflare credentials locally

To avoid passing `--api-token` and `--account-id` every time:

```bash
gsv local-config set cloudflare.api_token "$CF_API_TOKEN"
gsv local-config set cloudflare.account_id "$CF_ACCOUNT_ID"
```

## Configure a second machine

After deploying from one machine, set up the CLI on another:

```bash
curl -sSL https://install.gsv.space | bash
gsv local-config set gateway.url wss://gsv.your-subdomain.workers.dev/ws
gsv local-config set gateway.token your-auth-token
```

You can retrieve the auth token from the deploying machine with:

```bash
gsv config get auth.token
```
