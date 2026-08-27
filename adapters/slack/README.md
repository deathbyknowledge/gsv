# GSV Slack Adapter

The Slack adapter supports two deliberately separate deployments:

- Managed GSV uses one official, platform-owned Slack app that can be installed
  in many workspaces. Each Slack author confirms a short-lived code from a
  signed-in GSV session before their messages can reach an installation.
- Standalone GSV uses a Slack app owned by that deployment. It connects through
  Socket Mode, so the standalone adapter does not need a public Slack webhook.

Version one supports text in direct messages, channels, and threads. It does
not transfer Slack files or GSV attachments.

## Managed app setup

Create a distributable Slack app for the managed environment. You can start
from `slack-app.managed.example.yaml` (replace `SLACK_ORIGIN`), or configure it
manually:

1. Under **OAuth & Permissions**, add these bot token scopes:
   `app_mentions:read`, `chat:write`, `im:history`, and `im:write`.
2. Add this OAuth redirect URL, using the managed Slack Worker's public origin:
   `https://SLACK_ORIGIN/slack/oauth/callback`.
3. Under **Event Subscriptions**, set the Request URL to
   `https://SLACK_ORIGIN/slack/events`.
4. Under **App Home**, enable the Messages tab and allow users to send messages.
5. Subscribe to `app_mention`, `message.im`, and `app_uninstalled` events.
6. Enable app distribution for every workspace that should be able to install
   the official GSV app.

The managed deployment supplies these secrets:

- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_SIGNING_SECRET`
- `SLACK_OAUTH_STATE_SECRET` — a separate high-entropy secret used to sign the
  short-lived OAuth state

The deployment binds its externally reachable Worker origin as
`SLACK_PUBLIC_BASE_URL`. Staging and production should use separate Slack apps
and credentials.

### Managed user flow

1. Open **GSV → Messengers → Slack** and install the official GSV app in the
   intended Slack workspace. An existing workspace installation can be reused.
2. Mention `@GSV` in a channel, or send the app a direct message.
3. GSV sends a short-lived pairing code to that Slack author by direct message.
4. Enter the code in the signed-in GSV console and inspect the Slack identity.
5. Confirm the identity. Only this direct confirmation supplies the immutable
   GSV installation and local user that Slack traffic will use.
6. Mention `@GSV` again. The first message requested pairing and is not replayed
   to the agent.

Workspace installation and human pairing are different records. Installing the
app admits signed Slack events for that workspace, but does not choose a GSV.
Alice and Bob therefore receive different codes and can route to different GSV
installations even when they share one Slack workspace. Making Alice and Bob
GSV Contacts does not alter either default Slack route; any cross-GSV action
must be explicit federation initiated by the linked GSV.

In a public channel or thread, a response is prefixed with the Slack author it
came through, for example `From <@U123>'s GSV:`. Direct-message responses are
not prefixed. The adapter only delivers a public response to the exact channel
or thread previously observed for that author.

OAuth uses a signed state plus an `HttpOnly`, `Secure`, `SameSite=Lax` nonce
cookie. Event requests are verified with Slack's signing secret and replay
window before a workspace or peer Durable Object is addressed. Relinking an
author rotates their route generation; delayed ingress and output recheck that
generation and cannot cross to the old or new installation accidentally.

## Standalone app setup

1. Create an app at [Slack API Apps](https://api.slack.com/apps), optionally
   using `slack-app.standalone.example.yaml` as its manifest.
2. Add the same bot scopes used above: `app_mentions:read`, `chat:write`,
   `im:history`, and `im:write`.
3. Under **App Home**, enable the Messages tab and allow users to send messages.
4. Under **Event Subscriptions**, subscribe the bot to `app_mention`,
   `message.im`, and `app_uninstalled`.
5. Enable **Socket Mode**.
6. Create an app-level token with the `connections:write` scope. This is the
   `xapp-…` token.
7. Install the app in the workspace and copy its `xoxb-…` bot token.
8. In **GSV → Messengers → Slack**, enter both tokens.
9. Direct-message the app once and enter the one-time authorization code in
   GSV. After linking, direct messages and public `@GSV` mentions reach the
   standalone installation.

The console uses the stable local account ID `default`. Advanced deployments
can configure another account ID through the CLI. To keep tokens out of shell
history, set `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` as secrets on the adapter
Worker, then connect it without inline configuration:

```bash
gsv adapter connect --adapter slack --account-id default
gsv adapter status --adapter slack --account-id default
```

Disconnecting closes Socket Mode and clears both persisted tokens:

```bash
gsv adapter disconnect --adapter slack --account-id default
```

The Slack account Durable Object durably queues an event before acknowledging
its Socket Mode envelope. It retries the Gateway handoff with the event's stable
Slack identity. Outbound delivery uses an account-local idempotency ledger and
does not retry an ambiguous provider outcome.

## Endpoints

The standalone Worker exposes only health responses; Slack traffic enters over
its outbound Socket Mode connection.

The managed Worker exposes:

```text
GET  /slack/install
GET  /slack/oauth/callback
POST /slack/events
GET  /health
```

Human-approval prompts in direct messages include a `hil[requestId]` token.
Replies must include the exact current token; bare decisions and stale tokens
are rejected by the Gateway.
