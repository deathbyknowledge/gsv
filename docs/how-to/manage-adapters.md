# How to Manage Adapters

Use this guide when you want to connect or troubleshoot WhatsApp and Discord in
GSV.

Adapters connect GSV processes to external messaging systems such as WhatsApp
and Discord. The deployed adapter workers host protocol-specific code; the
Kernel sees them through `adapter.*` syscalls and linked external actors.

## Deploy Adapter Workers

Deploy the adapter components with infrastructure commands:

```bash
gsv infra deploy -c channel-whatsapp
gsv infra deploy -c channel-discord --discord-bot-token "$DISCORD_BOT_TOKEN"
```

If you deploy all components, both adapter workers are included:

```bash
gsv infra deploy --all
```

## Connect WhatsApp

```bash
gsv adapter connect --adapter whatsapp --account-id personal --config-json '{"force":true}'
gsv adapter status --adapter whatsapp --account-id personal
gsv adapter disconnect --adapter whatsapp --account-id personal
```

When WhatsApp needs pairing, the CLI prints a QR challenge. Scan it in WhatsApp:
Settings → Linked Devices → Link a Device.

## Connect Discord

Discord needs a bot token. You can provide it during deploy as a Worker secret,
or pass it when connecting:

```bash
gsv adapter connect --adapter discord --account-id default \
  --config-json '{"botToken":"<discord-bot-token>"}'
```

If the token is already configured, omit `--config-json`:

```bash
gsv adapter connect --adapter discord --account-id default
gsv adapter status --adapter discord
```

## Link External Actors

Inbound messages are not delivered to processes until the external actor is
linked to a GSV user.

For direct messages, an unlinked actor receives a challenge:

```text
Link your account by running: gsv auth link CODE
```

Redeem it as the target user:

```bash
gsv auth link CODE
```

Root can also link manually when the adapter, account, actor id, and target uid
are known.

## How Messages Route

1. The adapter worker receives a platform message.
2. The worker calls the Kernel with `adapter.inbound` using a service identity.
3. The Kernel resolves the adapter/account/actor link to a local uid.
4. The message is delivered to the routed process or `init:{uid}`.
5. The Process DO runs the agent loop and emits `chat.*` signals.
6. The Kernel sends replies back through `adapter.send`.

Pending human-in-the-loop approvals can be approved or denied from a linked DM
surface. Non-DM messages from unlinked actors are dropped.

## Troubleshooting

- If `adapter.connect` fails, verify the adapter worker was deployed and the Gateway has the correct service binding.
- If WhatsApp does not show a QR code, reconnect with `{"force":true}`.
- If Discord does not respond, check the bot token, invite permissions, gateway status, and Message Content Intent.
- If a message is ignored, confirm the actor id is linked to the intended user.

## See also

- [Connect Adapters](../get-started/connect-adapters.md)
- [The Adapter Model](../architecture/adapter-model.md)
- [Routing Reference](../reference/routing.md)
