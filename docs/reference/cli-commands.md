# CLI Command Reference

The `gsv` binary controls a GSV gateway, local device daemon, process tree, adapters,
packages, and Cloudflare infrastructure. Most commands talk to the Kernel syscall
surface over WebSocket; `infra` talks directly to Cloudflare.

## Global Options

`--url` is a top-level option, so place it before the subcommand:

```bash
gsv --url wss://example.workers.dev/ws chat "hello"
```

| Option | Env | Description |
| --- | --- | --- |
| `--url <URL>` | `GSV_URL` | Gateway WebSocket URL. Defaults to `gateway.url` in local config, then `ws://localhost:8787/ws`. |
| `-u, --user <USER>` | | Gateway username override. |
| `-p, --password <PASS>` | | Password for non-interactive login/setup. |
| `-t, --token <TOKEN>` | `GSV_TOKEN` | Non-interactive credential. User commands require a username with token auth. |

Local CLI config is stored at `~/.config/gsv/config.toml`. Remote user commands use
the cached session token from `gsv auth login`, or prompt/login when needed.

## Chat and Shell

```bash
gsv chat [MESSAGE] [--pid PID]
gsv shell
```

`chat` sends a message to a process with `proc.send`. With `MESSAGE`, it waits
for the matching `proc.run.finished` signal for up to 120 seconds. The
interactive prompt returns after each message is accepted so another message
can supersede an active run; type `quit` or `exit` to leave. `--pid` targets a
specific process; when omitted, the Kernel targets your default personal-agent
conversation. Set `GSV_CLIENT_DEBUG=1` to trace run-signal matching.

`shell` opens an interactive prompt backed by the gateway `shell.exec` syscall.
Commands run inside the gateway OS context, not directly on your local machine.
Use `:quit`, `:exit`, or `:q` to leave.

Inside the gateway shell, `proc` is the process IPC userland command.
`message` inspects and uses external chat reply routes. `sched add --here`
admits scheduled events to the current process conversation and preserves the
current authorized adapter reply destination when one exists.
`crontab` schedules background shell commands, while the remaining `sched`
commands inspect and control the Kernel schedule records:

```bash
proc self
proc list
proc spawn [--as ACCOUNT] [--non-interactive] [--label LABEL] [--prompt TEXT] [--] [prompt]
proc delegate [--as ACCOUNT] [--label LABEL] [--timeout 10m] <task>
proc reset [--pid PID]
proc kill PID [--no-archive]
proc send <pid> [--conversation id] [--metadata-json json] <message>
proc call <pid> [--conversation id] [--metadata-json json] [--timeout 60s] <message>
message current [--json]
message destinations [--all] [--json]
message attach PATH... [--mime TYPE]
message send --to DESTINATION [--message TEXT] [--attach PATH [--mime TYPE]] [--delivery-id ID] [--also]
crontab -l
crontab FILE
crontab -r
sched list [--all]
sched add --here --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE [--conversation ID]
sched add --to DESTINATION --name NAME (--every DURATION | --cron EXPR [--timezone ZONE] | --after DURATION | --at ISO_TIMESTAMP) --message MESSAGE
sched add --json JSON
sched enable <id>
sched disable <id>
sched remove <id>
sched run <id> [--force]
```

`proc spawn` always creates a fresh process. Its prompt is fire-and-forget, and
any answer remains in that child process's history. Unknown options are
rejected; use `--` before a positional prompt that begins with `-`. Use
`--non-interactive` for scheduled background work. `proc delegate` creates a
bounded child and reports the result to its caller as a process event; it
requires a process-backed caller and must not be placed in a crontab.
`proc send` is asynchronous same-owner process mail. `proc call` is bounded:
the source process receives either
`ipc.reply` or `ipc.timeout` in its default conversation. In a process-backed
shell, `proc self` prints the current process id and the shell exports it as
`GSV_PID`; a top-level user shell has no current process, so `proc self` exits
with an error there.

`message current` reports where the current run's final answer is delivered
automatically. `message attach` adds one or more GSV filesystem files to that
same final answer for native clients and adapter origins; it does not create an
extra message. Existing files in the current process's `/var/media` directory
are reused, while other readable files are staged there. Return the answer
normally. `message send` creates an
additional outbound message or sends to another authorized destination.
`message destinations` lists observed destinations that are online; `--all`
also includes known authorized destinations whose adapter account is offline.
Group, channel, and thread entries appear only after the linked actor addresses
GSV on that exact surface. Entries use opaque GSV ids and generic labels;
provider account, actor, surface, and message ids are not printed.

`--to here` selects the current adapter reply surface. An explicit send to that
same destination requires `--also`, acknowledging that it is intentionally in
addition to the automatic final reply. `--attach` streams one GSV filesystem
file; `--mime` overrides the inferred MIME type. Copy a file from a connected
target to GSV before attaching it:

```bash
cp laptop:/home/alice/report.pdf /tmp/report.pdf
message attach /tmp/report.pdf
message send --to here --message "Here is the report." --attach /tmp/report.pdf --also
```

`message send` allocates a stable delivery id before contacting an adapter and
retries one transport failure with that same id. If delivery still cannot be
confirmed, its error includes the id; pass it back with `--delivery-id` to
reconcile without creating a second logical message. Attachment-open failures
also report that id, including a failure while reopening the file for the
automatic retry. An outcome that may have reached the provider is reported as
`sent=false`, `delivery_confirmed=false`, and `delivery_state=ambiguous`.

Use `sched add --here` from a process-backed shell when each firing should admit
an event into the current process conversation. It creates a typed
`process.event` schedule for the current process and active conversation; pass
`--conversation` to override that conversation. When invoked during an adapter
run, `--here` captures the authorized adapter destination so the future final
answer returns there. Without such a route, the answer remains in the GSV
process conversation. The target is bound to the current process id and must be
recreated after that process is killed.

Use `sched add --to DESTINATION` for direct scheduled text delivery. It creates
an `adapter.send` scheduled action and does not run the agent. Destination
resolution includes known authorized offline destinations because the account
may be online when the schedule fires. Run `message destinations --all` and
copy its opaque GSV destination id; provider account, actor, and surface ids are
not part of the agent-facing command contract. `--conversation` is valid only
with `--here`.
A successful `process.event` firing records event admission, not completion of
a model turn or reply. Choose exactly one time expression. `--at` requires a
future ISO timestamp with `Z` or an explicit numeric UTC offset.

```bash
sched add --here --name animal-facts --every 2m --message "Send one obscure animal fact."
sched add --here --name daily-brief --cron "0 9 * * *" --timezone Europe/Amsterdam --message "Prepare the daily brief."
sched add --to MESSAGE_DESTINATION_ID --name standup --cron "0 9 * * 1-5" --message "Standup starts now."
```

Use `crontab FILE` or write `/var/spool/cron/<user>` for recurring background
shell-command automation. A cron command has no process-backed caller. If it
starts an agent process, use `proc spawn --non-interactive` and do not expect its
answer to appear in a chat:

```cron
0 9 * * * proc spawn --non-interactive --label refresh-index "Refresh the search index."
```

The crontab file is the desired state: reinstalling it deletes and recreates the
linked Kernel schedule rows, so crontab-backed `sched` ids are not stable. Use
`sched list` to inspect next fire time, last status, error, source, and target.
For a command that invokes `proc spawn`, status `ok` means the command was
dispatched and the spawn was accepted; it does not mean the child finished or
delivered output. `sched list --all` includes disabled schedules; it does not
mean all users. `sched add --json` is a low-level compatibility path for direct
`sched.*` payloads.

## Process Commands

```bash
gsv proc list [--uid UID]
gsv proc spawn [--as ACCOUNT] [--label LABEL] [--prompt TEXT] [--parent PID]
gsv proc send MESSAGE [--pid PID]
gsv proc history [--pid PID] [--limit N] [--offset N]
gsv proc reset [--pid PID]
gsv proc kill PID [--no-archive]
```

Processes are the agent-facing execution model. `spawn` creates a new process;
`send` only reports acceptance, while `chat` waits for streamed output.
`history` and `reset` use your default conversation when `--pid` is omitted.
`kill` requires a PID. `--uid` filters process lists and requires root when
viewing another user.

## Device Commands

```bash
gsv device run [--id ID] [--workspace PATH]
gsv device install [--id ID] [--workspace PATH]
gsv device start
gsv device stop
gsv device status
gsv device logs [-l N] [--follow]
```

The device daemon exposes local hardware-style capabilities to the Kernel:
`fs.*` and `shell.exec`. The gateway always sees the same syscall/tool surface;
the device ID selects which implementation receives a driver request.

`run` starts a foreground driver. `install` creates and starts a launchd agent on
macOS or a systemd user unit on Linux. The daemon writes daily rotated JSONL logs
under `~/.gsv/logs/device.log*`; `logs` tails the latest file with `-l, --lines`
defaulting to `100`. Foreground logs use compact text by default; set
`GSV_DEVICE_CONSOLE_FORMAT=json` or `GSV_DEVICE_CONSOLE_FORMAT=quiet` to change that.

Device identity resolves as `--id`, then local `device.id`, then
`device-<hostname>`. Workspace resolves as `--workspace`, then
`device.workspace`, then the current directory. A persistent daemon should have
`gateway.username` and `device.token` configured, usually from
`gsv auth setup --device-id ...` or
`gsv auth token create --kind device --device ...` followed by
`gsv config --local set device.token ...`.

## Auth Commands

```bash
gsv auth setup [--username USER] [--new-password PASS] [--root-password PASS] \
  [--ai-provider ID] [--ai-model MODEL] [--ai-api-key KEY] \
  [--device-id ID] [--device-label LABEL] [--device-expires-at UNIX_MS]
gsv auth login [--username USER] [--password PASS] [--ttl-hours N]
gsv auth logout
gsv auth link [CODE]
gsv auth link --adapter ID --account-id ACCOUNT --actor-id ACTOR [--uid UID]
gsv auth link-list [--uid UID]
gsv auth unlink --adapter ID --account-id ACCOUNT --actor-id ACTOR
```

`setup` initializes a gateway in setup mode, optionally configures AI provider
settings, and can issue a device token with `--device-id`, `--device-label`, and
`--device-expires-at` (Unix milliseconds). Interactive setup prompts for missing
values and saves `gateway.username`, `device.id`, and `device.token` when issued.

`login` creates a short-lived user token with `sys.token.create` and caches it
locally. The default TTL is 8 hours. `logout` clears only the cached local session
token.

Link commands bind adapter identities, such as WhatsApp or Discord actors, to
GSV users. Use a one-time `CODE` from an adapter flow or provide the adapter,
account, and actor identifiers manually.

### Auth Tokens

```bash
gsv auth token create [--kind device|service|user] [--uid UID] [--label LABEL] \
  [--role driver|service|user] [--device DEVICE] [--expires-at UNIX_MS]
gsv auth token list [--uid UID]
gsv auth token revoke TOKEN_ID [--reason TEXT] [--uid UID]
```

`device` is the default token kind. Use `--device` to bind a driver token to one
device ID. `--uid` is for root-managed token operations.

## User Management

```bash
gsv user create USER [--new-password PASS]
gsv user register USER [--new-password PASS] [--ttl-hours N]
gsv user permissions USER \
  [--grant CAPABILITY] [--revoke CAPABILITY] \
  [--add-group GROUP] [--remove-group GROUP]
```

`create` adds a login-capable human account and its personal agent. `register`
does the same, then logs in as the new user and replaces the locally cached
session; its default session lifetime is 8 hours. When `--new-password` is
omitted, both commands prompt without echo in an interactive terminal and fail
in non-interactive use. The global `--password` option authenticates the current
administrator; it is not the new account's password.

`permissions` without change options displays the user's primary and
supplementary groups, direct capabilities, and effective capabilities. Repeat
`--grant`, `--revoke`, `--add-group`, or `--remove-group` to apply multiple
changes in one request.

The gateway authorizes these operations before changing account, capability, or
group state. The current user must be uid 0 or have `user.admin` granted
directly on their primary group; other users receive `Permission denied`.

## Config Commands

```bash
gsv config get [KEY]
gsv config set KEY VALUE
gsv config --local get KEY
gsv config --local set KEY VALUE
```

Without `--local`, commands use Kernel `sys.config.get` and `sys.config.set`.
Keys use ConfigStore paths, for example:

```bash
gsv config get config/ai/provider
gsv config set users/1000/ai/model gpt-4.1-mini
```

Omit `KEY` on remote `get` to list visible entries. Sensitive remote values are
masked for non-root users. Non-root writes are limited to their own user
overrides, currently `users/{uid}/ai/*`.

With `--local`, commands edit `~/.config/gsv/config.toml`. Supported local keys:
`gateway.url`, `gateway.username`, `gateway.token`, `gateway.session_token`,
`gateway.session_token_id`, `gateway.session_expires_at`,
`gateway.session_expires_at_ms`, `cloudflare.account_id`,
`cloudflare.api_token`, `release.channel`, `r2.account_id`,
`r2.access_key_id`, `r2.secret_access_key`, `r2.bucket`,
`session.default_key`, `device.id`, `device.token`, `device.workspace`,
`channels.whatsapp.url`, and `channels.whatsapp.token`. `release.channel` must
be `stable` or `dev`; token and secret values are masked on local `get`.

## Adapter Commands

```bash
gsv adapter connect --adapter ID [--account-id ACCOUNT] [--config-json JSON]
gsv adapter disconnect --adapter ID [--account-id ACCOUNT]
gsv adapter status --adapter ID [--account-id ACCOUNT]
```

Adapters are long-lived external account bridges. `--account-id` defaults to
`default` for connect/disconnect. `--config-json` must be a JSON object and is
passed to the adapter implementation, for example:

```bash
gsv adapter connect --adapter whatsapp --config-json '{"pairing":true}'
```

## Package Commands

Package source and update workflows are handled in the GSV shell with `rgit`
and `pkg update <package>`. The CLI also exposes an explicit package sync:

```bash
gsv packages sync <package> [--ref REF]
```

## Infrastructure Commands

```bash
gsv infra deploy [--version REF] [-c COMPONENT ... | --all] [--force-fetch]
gsv infra upgrade [--version REF] [-c COMPONENT ... | --all] [--force-fetch]
gsv infra destroy [-c COMPONENT ... | --all] [--delete-bucket] [--purge-bucket]
```

Valid components are `ripgit`, `assembler`, `gateway`, `channel-whatsapp`,
`channel-discord`, and `channel-telegram`. When no deploy/upgrade component is supplied, all components
are selected. Deploying `gateway` requires `ripgit` and `assembler` to be
selected or already deployed.

`deploy` fetches release bundles and applies Cloudflare Workers. `upgrade` does
the same but auto-refreshes mutable refs such as `latest`, `stable`, and `dev`.
Both accept `--bundle-dir PATH` for local bundles, `--api-token` or
`CF_API_TOKEN`, `--account-id` or `CF_ACCOUNT_ID`, and `--discord-bot-token` or
`DISCORD_BOT_TOKEN`.

`destroy` tears down Workers. If no component or `--all` is supplied, it targets
all components. `--delete-bucket` removes the shared R2 bucket; `--purge-bucket`
must be combined with it. Unless `--keep-device` is passed, `destroy` also
attempts to uninstall the local device service.

## Version

```bash
gsv version
gsv --version
```

Prints build metadata for the installed CLI.

## Renamed or Removed Commands

| Old command | Current command |
| --- | --- |
| `gsv client` | `gsv chat` |
| `gsv session` | `gsv proc` |
| `gsv local-config` | `gsv config --local` |
| `gsv deploy` | `gsv infra` |
| `gsv tools`, `gsv skills`, `gsv init` | Removed from the current CLI. |

## See also

- [Get Started](../get-started/)
- [Connect Devices](../how-to/connect-devices)
- [Guides](../how-to/)
- [Routing Reference](./routing.md)
