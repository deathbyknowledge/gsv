# Connect Adapters

Use this page when you want to connect WhatsApp or Discord from the Desktop after
basic deployment is already working.

This flow assumes you have already finished [Get Started](./) and can open the
Desktop in your browser.

## 1. Open the Adapters App

The Desktop is made of package apps. If needed, open **Packages** first and make
sure the built-in apps are installed, then open **Adapters**.

If the adapter workers were not deployed yet, deploy them from the CLI:

```bash
gsv infra deploy -c channel-whatsapp
gsv infra deploy -c channel-discord --discord-bot-token "$DISCORD_BOT_TOKEN"
```

Deploying everything with `gsv infra deploy --all` includes both adapter workers.

## 2. Connect WhatsApp

In **Adapters**:

1. Select **WhatsApp**.
2. Use account id `primary` unless you need multiple WhatsApp accounts.
3. Click **Connect**. Enable force/reconnect if you are replacing an old pairing.
4. Scan the QR code in WhatsApp: Settings → Linked Devices → Link a Device.

After pairing completes, the account should move to a connected state.

## 3. Connect Discord

Create a Discord bot in the Discord Developer Portal:

1. Create an application and add a bot.
2. Copy the bot token.
3. Enable **Message Content Intent** if the bot needs to read message text.
4. Invite the bot to the server where you want to use it.

Then in **Adapters**:

1. Select **Discord**.
2. Use account id `main` unless you need multiple bot accounts.
3. Paste the bot token, or leave it blank if it was already provided at deploy time.
4. Click **Connect** and confirm the status becomes connected.

Mention the bot in a server or send it a direct message.

## 4. Link External Identities

GSV does not deliver unlinked external actors directly into a user's process.
The normal flow is:

1. Send a message from WhatsApp or Discord.
2. Copy the one-time link code returned by the adapter.
3. Open **Control**, then **Access**.
4. Redeem the code under **Identity links**.
5. Send another message from the external account.

Root users can also create links manually when they know the adapter, account id,
actor id, and target uid.

## 5. CLI Fallback

Use CLI adapter commands when you want scripting or terminal diagnostics:

```bash
gsv adapter connect --adapter whatsapp --account-id primary --config-json '{"force":true}'
gsv adapter status --adapter whatsapp --account-id primary

gsv adapter connect --adapter discord --account-id main \
  --config-json '{"botToken":"<discord-bot-token>"}'
gsv adapter status --adapter discord --account-id main
```

Redeem a link code from the CLI if you are logged in as the target user:

```bash
gsv auth link CODE
```

## Troubleshooting

- If **Adapters** is missing, sync or reinstall the built-in packages.
- If WhatsApp does not show a QR code, reconnect with force enabled.
- If Discord stays offline, verify the bot token, invite permissions, gateway state, and Message Content Intent.
- If messages are ignored, confirm that the external actor is linked to the intended user.

## See also

- [Get Started](./)
- [How to Manage Adapters](../how-to/manage-adapters.md)
- [The Adapter Model](../architecture/adapter-model.md)
