---
name: gsv-first-run-setup
description: Initialize a fresh GSV gateway, complete setup mode, create the first user, configure AI, bootstrap root/gsv, and connect the first device.
---

# GSV First-Run Setup

## When to Use

Use this skill when deploying or initializing a new GSV instance, completing first-run setup, or diagnosing what setup/bootstrap should have created.

## Setup Flow

1. Deploy infrastructure with the CLI:

```bash
gsv infra deploy --all
```

2. Store the Gateway WebSocket URL if using the CLI:

```bash
gsv config --local set gateway.url "wss://gsv.<subdomain>.workers.dev/ws"
```

3. Complete setup in the Web UI when possible. Quick start creates the first Desktop user, admin access, AI defaults, timezone, bootstrap state, and optional device setup. Customize and Advanced expose more configuration.

4. CLI setup is the fallback path:

```bash
gsv auth setup \
  --username admin \
  --new-password "$GSV_PASSWORD" \
  --ai-provider openrouter \
  --ai-model openai/gpt-4.1 \
  --ai-api-key "$OPENROUTER_API_KEY" \
  --node-id macbook
```

5. Log in and test:

```bash
gsv auth login --username admin
gsv chat "hello"
```

## Bootstrap Effects

Setup calls bootstrap. Bootstrap imports the configured GSV source into `root/gsv`, seeds builtin packages, mirrors CLI assets, and seeds repo-root `skills/` into each bootstrapped user's `~/skills.d/` when missing.

Root and the first non-root user should both have home storage layout including `context.d`, `skills.d`, and `knowledge`.

## First Device

The preferred path is the Desktop `Devices` app. It can issue a token and show the command for the current deployment.

Manual equivalent:

```bash
gsv config --local set gateway.username "admin"
gsv config --local set node.id "macbook"
gsv config --local set node.token "<device-token>"
gsv device install --id macbook --workspace ~/projects
gsv device status
```

## Pitfalls

- First-run setup is not normal login. Once setup mode is complete, use `gsv auth login` or the Web login flow.
- Do not log API keys, setup tokens, device tokens, passwords, or full bootstrap commands containing secrets.
- Do not document root password behavior by guesswork. Check current setup code or UI if root lock/password semantics matter.
- Builtin package changes are not applied by setup alone after the system is already running; they need the package update path.
