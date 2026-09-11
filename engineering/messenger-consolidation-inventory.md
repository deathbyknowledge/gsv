# Messenger ownership and rollout inventory

The new deployment uses operator-owned applications and per-human links. This
inventory records the compatibility boundaries for W5 and adapter/mail erasure.
Physical identifiers below retain their existing spelling until an explicit
migration replaces them. Source naming does not migrate a Durable Object.

| Surface | Producer and authority | Consumer | Persisted identity / rollout |
|---|---|---|---|
| `adapter.list.enabled`, `canLink` | Kernel validates the trusted `CHANNEL_*` descriptor and shared application's pairing configuration; credential-authenticated human and grant determine `canLink` | Web inventory normalization and Settings messengers | Additive result fields; old responses grant no new linking authority. Deploy Kernel with matching web assets. |
| `adapter.pair.*` | Kernel supplies its immutable installation id, local human uid and canonical origin after direct human authorization | Adapter prepare/activate/finalize/disconnect RPCs | Existing operation ids and generation-fenced receipts remain authoritative. Provider events/codes never select the installation. |
| Telegram application | Operator `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` | Shared Telegram webhook and API owner | `ManagedTelegramPeer`, `ManagedTelegramPairing`; peer name `managed:<private-chat-id>`, pairing name `pair:<code>`, account id `managed`. Preserve `managed_telegram_pairing:v1`. |
| Slack application and external workspace | Operator client id/secret, signing secret, OAuth state secret and public callback origin; authenticated OAuth installs the workspace | Shared Slack HTTP owner, workspace and actor peers | `ManagedSlackWorkspace`, `ManagedSlackPeer`, `ManagedSlackPairing`; workspace account digest, peer `(accountId, actorId)`, `managed_slack_pairing:v1`. External workspace ownership does not select a GSV installation. |
| Discord shared application | Operator `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`; minute cron / pairing info starts app | `SharedDiscordChannel`, authenticated Discord Gateway dispatch | New `DiscordApplication` name `application:<app-id>`, `DiscordPeer` name `peer:application:<app-id>[:guild:<guild-id>]:user:<user-id>`, `DiscordPairing` name `pair:<code>`. KV keys `state`, `botUser`, `guild:<guild-id>`, `discord_peer:v1`, `discord_peer:inbound:`, `discord_pairing:v1`, existing delivery ledger prefix. No installation authority resides in the application/server install. |
| Discord legacy application | Legacy installation-owned `DiscordGateway` and token enrollment | Legacy `DiscordChannel` | Preserve existing `DiscordGateway` namespace, singleton account names and stored session until W7's explicit cutover. Shared Discord must use one operator application connection and per-actor routes. |
| Kernel identity projection | Successful direct human pair confirmation | Ingress authorization, destination access, recovery, Settings | Keep link `managed: true`, `routeGeneration`, `routeScope`, `surfaceId`, and status mode `managed-shared`. These are stored compatibility values. |
| Mail | Recipient host resolution through Accounts; trusted outbound queue command | `MailInstallation` named by immutable installation id | Preserve namespace, inbound chunks, summary generation, outbound ledgers, quota reservations and callbacks until acknowledged cleanup. Sending-domain credentials belong to the operator. |

The shared Discord batch reuses the existing provider transport and delivery implementation,
with opcode/event-specific decoding. Discord's
[Gateway contract](https://docs.discord.com/developers/events/gateway) distinguishes
connection control packets from message dispatches; a HELLO or ACK is not a
message. Guild installs are application state. A guild actor route and the same
actor's DM route are separate scopes under that application.

## Deletion evidence

Current Kernel links alone cannot establish a complete adapter resource inventory.
A peer may retain old-generation ingress, delivery/HIL receipts, a prepared or
consumed pairing claim, or a previous route after the live link moved elsewhere.
The lifecycle owner must include those records and the pairing Durable Objects,
not merely the newest route. New ownership registration must precede activation
or payload retention. Adopted namespaces require independently enumerated prior
peers/claims and a verified inventory receipt before full erasure can be claimed.
Missing historical evidence is `missing-inventory`.

Cleanup is keyed by immutable installation id and exact route generation. An old
installation's cleanup cannot remove a newer route to another installation,
another person's link, or an operator bot/workspace credential. Quiesce fences
late ingress, provider sends and retries before erasure begins; a minimal durable
tombstone survives erasure. A lost response resumes the same recorded operation.

Accounts owns the frozen service participant list, including formerly enabled
owners. Adapter/mail owners retain their resource inventories until every owning
DO acknowledges cleanup. Operator-controlled logs, backups, provider records and
caches require an explicit deletion/expiry policy; live-state erasure does not
by itself establish final erasure of retained copies.

## Retirement owners

`TelegramLifecycleEntrypoint`, `SlackLifecycleEntrypoint`, and
`DiscordLifecycleEntrypoint` accept only the deployment's
`installation-deletion` authority. Accounts authorizes capture/import only for a
retained space; cleanup/status also accept deleting/deleted tombstones. Concrete
provider namespaces validate every physical name against its Durable Object id.

Each provider has one `adapter-installation` index named by immutable
`installationId`: `TelegramInstallation` (`TELEGRAM_INSTALLATIONS`),
`SlackInstallation` (`SLACK_INSTALLATIONS`), and `DiscordInstallation`
(`DISCORD_INSTALLATIONS`). Accounts primes these objects before opening a
capture epoch. Registration precedes ownership writes, and inventory import
freezes the exact full participant list. A retained pointer to an understood
empty or unrelated peer still requires that peer's retirement fence; unknown
records never become identified merely because an index mentions them.

New inbound, outbound and approval records carry explicit installation and
route-generation ownership; platform pairing messages are explicitly unowned
by any space. Duplicate provider ingress keeps its first recorded owner after
a relink. Historical records without enough durable attribution remain
`unidentified` and block completion. Existing pairing keys and payload layouts
remain readable, and an expiry alarm removes the claim without deleting its
retirement tombstone.

Slack's workspace is a shared `adapter-account`: cleanup removes only the
retired space's actor routes, attributed user OAuth credentials and attributed
DM caches. The operator bot token and other people's state remain. Shared
Discord's operator connection is the separate `adapter-application` kind;
the legacy `DiscordGateway` namespace remains inventoried as
`adapter-account`. Its stored local account ID and directory-verified candidate
space IDs must reproduce the exact namespace object ID before ownership is
accepted. The supported standalone name projection remains distinct, including
local names that resemble a scoped account name. A proven legacy account owns
its complete KV state, so retirement fences its connection, provider work and
ledger writes before bounded cleanup; unknown application SQL or unproven
identity blocks cleanup. The shared application and other spaces remain intact.

The adapters report live erasure separately from their durable-storage backup
window. Their receipt retains a 30-day PITR window plus a one-minute precision
buffer. The installation coordinator keeps physical routing records until child
owners finish, then removes them and starts its own final backup window from
that removal. A previously elapsed child-backup window does not clear these
newly retained registry copies. Final erasure additionally depends on Accounts' independent inventory
and the other declared retention owners, including external provider records.
