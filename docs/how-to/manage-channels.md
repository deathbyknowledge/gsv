# How to Manage Adapters

Adapters connect GSV processes to external messaging systems such as WhatsApp
and Discord. The deployed channel Workers host protocol-specific code; the
Kernel sees them through `adapter.*` syscalls and linked external actors.

## Deploy Adapter Workers

Deploy adapter components with infrastructure commands:

```bash
gsv infra deploy -c channel-whatsapp
gsv infra deploy -c channel-discord --discord-bot-token "$DISCORD_BOT_TOKEN"
```

If you deploy all components, both adapter Workers are included:

```bash
gsv infra deploy --all
```

## Connect WhatsApp

Start or reconnect a WhatsApp account:

```bash
gsv adapter connect --adapter whatsapp --account-id personal --config-json '{"force":true}'
```

When WhatsApp needs pairing, the CLI prints a QR challenge. Scan it from
WhatsApp: Settings, Linked Devices, Link a Device.

Check and disconnect:

```bash
gsv adapter status --adapter whatsapp --account-id personal
gsv adapter disconnect --adapter whatsapp --account-id personal
```

## Connect Discord

Discord needs a bot token. You can provide it during deploy as a Worker secret,
or pass it when connecting:

```bash
gsv adapter connect --adapter discord --account-id default \
  --config-json '{"botToken":"<discord-bot-token>"}'
```

If the token is already configured as `DISCORD_BOT_TOKEN`, omit `--config-json`:

```bash
gsv adapter connect --adapter discord --account-id default
gsv adapter status --adapter discord
```

Invite the bot with the permissions required by your deployment and enable the
Discord Message Content Intent when the bot needs to read message text.

## Link External Actors

Inbound messages are not delivered to processes until the external actor is
linked to a GSV user.

For direct messages, an unlinked actor receives a challenge:

```text
Link your account by running: gsv auth link CODE
```

Run that command as the target user:

```bash
gsv auth link CODE
```

Root can link manually when the adapter, account, and actor id are known:

```bash
gsv auth link --adapter discord --account-id default --actor-id discord:user:123456 --uid 1000
gsv auth link --adapter whatsapp --account-id personal --actor-id wa:jid:31600000000@s.whatsapp.net --uid 1000
```

Inspect and remove links:

```bash
gsv auth link-list
gsv auth unlink --adapter discord --account-id default --actor-id discord:user:123456
```

## How Messages Route

1. The adapter Worker receives a platform message.
2. The Worker calls the Kernel with `adapter.inbound` using a service identity.
3. The Kernel resolves the adapter/account/actor link to a local uid.
4. The message is delivered to the surface-routed process or `init:{uid}`.
5. The Process DO runs the agent loop and emits `chat.*` signals.
6. The Kernel sends replies back through `adapter.send`.

Pending human-in-the-loop approvals can be approved or denied from a linked DM
surface. Non-DM messages from unlinked actors are dropped.

## Troubleshooting

- If `adapter.connect` fails, verify the channel Worker was deployed and the
  Gateway has the correct service binding.
- If WhatsApp does not show a QR code, reconnect with `{"force":true}`.
- If Discord does not respond, check the bot token, gateway status, invite
  permissions, and Message Content Intent.
- If a message is ignored, check `gsv auth link-list` and confirm the actor id is
  linked to the intended user.
