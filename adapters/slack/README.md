# GSV Slack Adapter

The Slack adapter supports two deliberately separate deployments:

- Managed GSV uses one official, platform-owned Slack app that can be installed
  in many workspaces. Each Slack author confirms a short-lived code from a
  signed-in GSV session before their messages can reach an installation.
- Standalone GSV uses a Slack app owned by that deployment. It connects through
  Socket Mode, so the standalone adapter does not need a public Slack webhook.

Slack supports text and files in direct messages, channels, and threads.
Files attached to a direct message or an explicit `@GSV` message are retained
once as immutable GSV resources. GSV resource attachments are uploaded as
native Slack files into the originating channel or thread.

## Managed app setup

Create a distributable Slack app for the managed environment. You can start
from `slack-app.managed.example.yaml` (replace `SLACK_ORIGIN`), or configure it
manually:

1. Under **OAuth & Permissions**, add these bot token scopes:
   `app_mentions:read`, `chat:write`, `chat:write.public`, `files:read`,
   `files:write`, `im:history`, `im:write`, and `reactions:write`.
2. Add these user token scopes: `channels:history`, `channels:read`,
   `groups:history`, `groups:read`, `im:history`, `im:read`, `mpim:history`,
   `mpim:read`, and `users:read`.
3. Add this OAuth redirect URL, using the managed Slack Worker's public origin:
   `https://SLACK_ORIGIN/slack/oauth/callback`.
4. Under **Event Subscriptions**, set the Request URL to
   `https://SLACK_ORIGIN/slack/events`.
5. Under **Interactivity & Shortcuts**, enable Interactivity and set the Request
   URL to `https://SLACK_ORIGIN/slack/interactions`.
6. Under **App Home**, enable the Messages tab and allow users to send messages.
7. Subscribe to `app_mention`, `message.im`, and `app_uninstalled` events.
8. Enable app distribution for every workspace that should be able to install
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

1. Open **GSV → Messengers → Slack** and authorize the official GSV app in the
   intended Slack workspace. Slack reuses an existing workspace installation,
   but each person who wants the Slack target must complete this authorization
   once so GSV receives that person's scoped user token.
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

### Managed Slack target

After personal OAuth authorization and pairing, GSV projects that Slack
workspace as an online target. Discover its opaque target id with `targets list`,
then select it with the ordinary Shell `target` argument. The target is an
ephemeral just-bash environment containing a composable `slack` command:

```bash
slack whoami
slack conversations list --json | jq -r '.items[] | [.id, .name] | @tsv'
slack conversations history --channel C123 --json
slack conversations replies --channel C123 --timestamp 1700000000.000100 --json
printf '%s' 'hello from GSV' | slack messages send --channel C123
slack reactions add --channel C123 --timestamp 1700000000.000100 --name eyes
slack users list --json
slack users info --user U123 --json
```

Run `slack --help` inside the target for the exact inventory. Reads use the
paired person's `xoxp-…` OAuth visibility, while messages and reactions use the
installed GSV app's `xoxb-…` identity. Neither token is placed in the shell
environment or output. Every target-originated message is prefixed with
`From <@U123>'s GSV:` so its human owner remains visible on channels, threads,
and direct messages. The app can post in public channels without joining;
reactions and private-channel mutations require it to be explicitly invited.
A route change, disconnect, reauthorization, timeout, or Process cancellation
fences late output and cancels the owning provider request.

The target is distinct from messaging. `message destinations` discovers
authorized conversation delivery surfaces and `message send` commits a
user-visible GSV Message. A `slack messages send` command is inspectable external
tool activity performed by the GSV Slack app. The standalone shared bot remains
transport-only until it has an explicit policy for granting bot-wide authority.

## Standalone app setup

1. Create an app at [Slack API Apps](https://api.slack.com/apps), optionally
   using `slack-app.standalone.example.yaml` as its manifest.
2. Add the same bot scopes used above: `app_mentions:read`, `chat:write`,
   `files:read`, `files:write`, `im:history`, and `im:write`.
3. Under **App Home**, enable the Messages tab and allow users to send messages.
4. Under **Event Subscriptions**, subscribe the bot to `app_mention`,
   `message.im`, and `app_uninstalled`.
5. Under **Interactivity & Shortcuts**, enable Interactivity. Socket Mode carries
   the interaction payload, so no public Request URL is needed.
6. Enable **Socket Mode**.
7. Create an app-level token with the `connections:write` scope. This is the
   `xapp-…` token.
8. Install the app in the workspace and copy its `xoxb-…` bot token.
9. In **GSV → Messengers → Slack**, enter both tokens.
10. Direct-message the app once and enter the one-time authorization code in
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

## Files and attachments

The adapter handles only files carried by an addressed `app_mention` or
`message.im` event. It does not subscribe to workspace-wide `file_shared`
events and does not download arbitrary link-unfurl URLs.

Inbound private Slack URLs are refreshed with `files.info`, downloaded with the
workspace bot token, and streamed through the adapter's single owned binary
body. The Gateway retains the bytes under the run-as agent and commits only the
immutable resource reference to conversation history. Private Slack URLs and
bot credentials never become resource metadata.

Outbound resources are hydrated only for delivery. The adapter uses
`files.getUploadURLExternal`, uploads each file, and calls
`files.completeUploadExternal` once for the batch with the authorized channel
and parent thread. Text and shared-channel attribution become the file
message's initial comment. The common GSV message-media limits apply: at most
20 items and 48 MiB total. Unlike plain text sent with `chat:write.public`, file
sharing requires the GSV app to be a member of the destination conversation.

Existing managed workspace installations must use the install link again to
approve the file and app-owned target scopes. Every managed user who wants the
target must authorize its read scopes once. Existing standalone apps must add
`files:read` and `files:write`, reinstall the app in the workspace, and reconnect
the adapter so Slack issues a token with those permissions.

## Approval buttons

Human-approval prompts in direct messages keep their complete text fallback and
add **Approve once**, **Always approve**, and **Deny** buttons. A click becomes
the same exact `approve hil[requestId]`, `approve always hil[requestId]`, or
`deny hil[requestId]`
command accepted by the Gateway; typed token-bearing replies continue to work.
Once submitted, the original message is updated to remove its buttons.

The adapter durably records an interaction before acknowledging it. Managed
button values are also bound to the linked route generation, so a delayed click
from before a relink cannot reach the previous or replacement installation.
The Gateway remains authoritative for the current HIL token and rejects stale
or repeated decisions.

## Endpoints

The standalone Worker exposes only health responses; Slack traffic enters over
its outbound Socket Mode connection.

The managed Worker exposes:

```text
GET  /slack/install
GET  /slack/oauth/callback
POST /slack/events
POST /slack/interactions
GET  /health
```
