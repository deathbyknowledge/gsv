# GSV Discord Adapter

Discord bot integration for GSV Gateway.

## Operator application and human pairing

The shared deployment uses `wrangler.shared.jsonc` and the `SharedDiscordChannel`
service entrypoint. The operator sets `DISCORD_APPLICATION_ID` and the
`DISCORD_BOT_TOKEN` secret at deployment time. A minute cron starts the single
`DiscordApplication` provider connection; opening the pairing flow also starts it.
The application token is read from the binding and is never stored in peer state.

A person installs the bot in a Discord server, mentions it with `pair`, or sends
it a direct message. The bot sends a private pairing code. In **your GSV →
Messengers → Discord**, that person inspects the identity and confirms the link.
Server installation itself does not link anyone or select a space. Two people in
the same server may link different spaces. A person's server route and direct
message route are distinct; each route has one active space and local account.

The shared application receives direct messages and messages that mention the bot
(including replies to it), using the non-privileged Guilds, Guild Messages, and
Direct Messages intents. It does not request Message Content. The install link
requests View Channels, Send Messages, Attach Files, and Read Message History.
The adapter advertises that typing activity is unavailable on this shared path.
See Discord's [Gateway documentation](https://docs.discord.com/developers/events/gateway)
for the message-content exceptions for direct messages and bot mentions.

`DiscordPeer` durably owns pairing, delivery, ingress, and its generation-fenced
route. Delayed messages and media replies recheck the route before crossing the
Gateway or provider boundary. A relink invalidates the previous generation and
cleans the old Kernel projection. Approvals remain human-facing and include a
link to the person's GSV; they do not wake a parent model.

The shared Worker exposes only `/health` over HTTP. Provider ingress arrives on
the operator's authenticated Gateway connection. Service bindings carry the
existing attenuated Discord adapter grant. No public route accepts a token,
installation id, or local account id.

## Historical cleanup ownership

The existing `DiscordGateway` namespace and class remain available only to the
installation deletion owner. They inspect and erase retained account data using
its original physical identity. They cannot start a provider connection, send a
message, expose a saved token, or reconnect from an alarm. They are not a second
deployment option. Existing records are preserved until an authorized cleanup;
this code change does not itself establish erasure evidence.

`DiscordApplication` retains the operator connection and its existing namespace.
`DiscordPeer` retains each human route and its bounded ingress/outbound ledgers.
The transport base is internal to the shared application and is not a Worker
entrypoint or a new Durable Object namespace.

## Messages and attachments

| Context | Behavior |
| --- | --- |
| Direct message | Messages from the paired human enter the linked space. |
| Server channel or thread | Messages enter only when the bot is mentioned or replied to, through that author's confirmed server route. |

Inbound attachments travel through one owned binary body to immutable GSV
resources. Outbound resources are hydrated for the exact routed destination.
Delivery keeps a stable id and content fingerprint; retries preserve Discord's
deterministic nonce. A stale route generation cannot deliver after relinking or
installation retirement.

## Troubleshooting

- If no pairing code arrives, check the operator application token, the bot’s
  channel permissions, and that the message mentions the bot or is a DM.
- If the code expired, request another and confirm it from the intended signed-in
  space. Installing the bot in a server does not pair its members.
- If a session is invalid, the operator checks the application credential and
  provider connection logs. Users do not paste bot tokens into their space.
