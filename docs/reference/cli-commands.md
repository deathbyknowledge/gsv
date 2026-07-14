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

Inside the gateway shell, `proc` is the process IPC userland command and
`crontab` is the normal scheduling interface. `sched` is the lower-level
inspector/control command for the Kernel schedule records that back cron jobs
and other schedule targets:

```bash
proc self
proc list
proc spawn [--as ACCOUNT] [--label LABEL] [--prompt TEXT]
proc reset [--pid PID]
proc kill PID [--no-archive]
proc send <pid> [--conversation id] [--metadata-json json] <message>
proc call <pid> [--conversation id] [--metadata-json json] [--timeout 60s] <message>
crontab -l
crontab FILE
crontab -r
sched list [--all]
sched add --json JSON
sched enable <id>
sched disable <id>
sched remove <id>
sched run <id> [--force]
```

`proc spawn` always creates a fresh process. `proc send` is asynchronous
same-owner process mail. `proc call` is bounded: the source process receives
either `ipc.reply` or `ipc.timeout` in its default conversation. In a
process-backed shell, `proc self` prints the current process id and the shell
exports it as `GSV_PID`; a top-level user shell has no current process, so
`proc self` exits with an error there.

Use `crontab FILE` or write `/var/spool/cron/<user>` for recurring shell-command
automation. The crontab file is the desired state: reinstalling it deletes and
recreates the linked Kernel schedule rows, so crontab-backed `sched` ids are not
stable. Use `sched list` to inspect next fire time, last status, error, source,
and target. `sched list --all` includes disabled schedules; it does not mean all
users. `sched add --json` is a low-level compatibility path for direct
`sched.*` payloads, not the recommended way to create ordinary cron jobs.

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
gsv infra deploy [--version REF] [-c COMPONENT ... | --all] [--instance NAME] [--force-fetch] [--lease-manifest PATH]
gsv infra upgrade [--version REF] [-c COMPONENT ... | --all] [--instance NAME] [--force-fetch] [--lease-manifest PATH]
gsv infra status [-c COMPONENT ... | --all] [--instance NAME] [--json]
gsv infra destroy [-c COMPONENT ... | --all] [--instance NAME] [--delete-bucket] [--purge-bucket] [--verify]
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

`--instance` scopes every generated Worker and R2 name, which allows isolated
deployments to coexist in one Cloudflare account. `--lease-manifest` writes a
schema-versioned JSON inventory before Cloudflare mutation begins, then
atomically adds the gateway URL after a successful apply. The manifest contains
resource names and release provenance, never credentials.

`status` reports the selected instance as `absent`, `partial`, or `deployed`.
With `--json`, stdout contains only the schema-versioned status document; an
absent instance is a successful result, while authentication and API failures
remain nonzero.

`destroy` tears down Workers. If no component or `--all` is supplied, it targets
all components. `--delete-bucket` removes the shared R2 bucket; `--purge-bucket`
must be combined with it. Unless `--keep-device` is passed, `destroy` also
attempts to uninstall the local device service. `--verify` polls the selected
Workers and any requested bucket, retries eventually consistent R2 cleanup, and
returns nonzero if owned resources remain.

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
