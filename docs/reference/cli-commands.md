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

`chat` sends a message to a process with `proc.send` and waits for `chat.*`
signals for up to 120 seconds. Omit `MESSAGE` for an interactive prompt; type
`quit` or `exit` to leave. `--pid` targets a specific process; when omitted, the
Kernel targets your init process. Set `GSV_CLIENT_DEBUG=1` to trace chat signal
matching.

`shell` opens an interactive prompt backed by the gateway `shell.exec` syscall.
Commands run inside the gateway OS context, not directly on your local machine.
Use `:quit`, `:exit`, or `:q` to leave.

## Process Commands

```bash
gsv proc list [--uid UID]
gsv proc spawn [--label LABEL] [--prompt TEXT] [--parent PID]
gsv proc send MESSAGE [--pid PID]
gsv proc history [--pid PID] [--limit N] [--offset N]
gsv proc reset [--pid PID]
gsv proc kill PID [--no-archive]
```

Processes are the agent-facing execution model. `spawn` creates a child process;
`send` only reports acceptance, while `chat` waits for streamed output.
`history`, `reset`, and `kill` operate on the selected process or your init
process when `--pid` is omitted. `--uid` filters process lists and requires root
when viewing another user.

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
macOS or a systemd user unit on Linux. The daemon logs to `~/.gsv/logs/node.log`;
`logs` tails that file with `-l, --lines` defaulting to `100`.

Device identity resolves as `--id`, then local `node.id`, then
`node-<hostname>`. Workspace resolves as `--workspace`, then `node.workspace`,
then the current directory. The command name is `device`, but local config still
uses `node.*` keys because those are the persisted driver fields. A persistent
daemon should have `gateway.username` and `node.token` configured, usually from
`gsv auth setup --node-id ...` or `gsv auth token create --kind node --device ...`
followed by `gsv config --local set node.token ...`.

## Auth Commands

```bash
gsv auth setup [--username USER] [--new-password PASS] [--root-password PASS] \
  [--ai-provider ID] [--ai-model MODEL] [--ai-api-key KEY] \
  [--node-id ID] [--node-label LABEL] [--node-expires-at UNIX_MS]
gsv auth login [--username USER] [--password PASS] [--ttl-hours N]
gsv auth logout
gsv auth link [CODE]
gsv auth link --adapter ID --account-id ACCOUNT --actor-id ACTOR [--uid UID]
gsv auth link-list [--uid UID]
gsv auth unlink --adapter ID --account-id ACCOUNT --actor-id ACTOR
```

`setup` initializes a gateway in setup mode, optionally configures AI provider
settings, and can issue a device token with `--node-id`, `--node-label`, and
`--node-expires-at` (Unix milliseconds). Interactive setup prompts for missing
values and saves `gateway.username`, `node.id`, and `node.token` when issued.

`login` creates a short-lived user token with `sys.token.create` and caches it
locally. The default TTL is 8 hours. `logout` clears only the cached local session
token.

Link commands bind adapter identities, such as WhatsApp or Discord actors, to
GSV users. Use a one-time `CODE` from an adapter flow or provide the adapter,
account, and actor identifiers manually.

### Auth Tokens

```bash
gsv auth token create [--kind node|service|user] [--uid UID] [--label LABEL] \
  [--role driver|service|user] [--device DEVICE] [--expires-at UNIX_MS]
gsv auth token list [--uid UID]
gsv auth token revoke TOKEN_ID [--reason TEXT] [--uid UID]
```

`node` is the default token kind. Use `--device` to bind a driver token to one
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
`session.default_key`, `node.id`, `node.token`, `node.workspace`,
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

```bash
gsv packages sync
```

`sync` re-seeds builtin packages from the mirrored `system/gsv` repository through
the `pkg.sync` syscall and prints the resolved package commits.

## Infrastructure Commands

```bash
gsv infra deploy [--version REF] [-c COMPONENT ... | --all] [--force-fetch]
gsv infra upgrade [--version REF] [-c COMPONENT ... | --all] [--force-fetch]
gsv infra destroy [-c COMPONENT ... | --all] [--delete-bucket] [--purge-bucket]
```

Valid components are `ripgit`, `assembler`, `gateway`, `channel-whatsapp`, and
`channel-discord`. When no deploy/upgrade component is supplied, all components
are selected. Deploying `gateway` requires `ripgit` and `assembler` to be
selected or already deployed.

`deploy` fetches release bundles and applies Cloudflare Workers. `upgrade` does
the same but auto-refreshes mutable refs such as `latest`, `stable`, and `dev`.
Both accept `--bundle-dir PATH` for local bundles, `--api-token` or
`CF_API_TOKEN`, `--account-id` or `CF_ACCOUNT_ID`, and `--discord-bot-token` or
`DISCORD_BOT_TOKEN`.

`destroy` tears down Workers. If no component or `--all` is supplied, it targets
all components. `--delete-bucket` removes the shared R2 bucket; `--purge-bucket`
must be combined with it. Unless `--keep-node` is passed, `destroy` also attempts
to uninstall the local device service.

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
| `gsv node` | `gsv device` |
| `gsv session` | `gsv proc` |
| `gsv local-config` | `gsv config --local` |
| `gsv deploy` | `gsv infra` |
| `gsv tools`, `gsv skills`, `gsv init` | Removed from the current CLI. |
